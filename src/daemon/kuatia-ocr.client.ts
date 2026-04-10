import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ProcessWithOcrRequest {
  documento: string;
  empresaId: number;
  prompt: string;
  documentId: number;
}

interface DocumentFilePayload {
  mimeType: string;
  buffer: Buffer;
}

@Injectable()
export class KuatiaOcrClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly apiToken: string | null;
  private readonly processPath: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>('KUATIA_OCR_BASE_URL') ??
      'http://localhost:3000';
    this.timeoutMs = Number(
      this.configService.get<string>('KUATIA_OCR_TIMEOUT_MS') ?? 120000,
    );
    this.downloadTimeoutMs = Number(
      this.configService.get<string>('KUATIA_OCR_DOWNLOAD_TIMEOUT_MS') ??
        this.timeoutMs,
    );
    this.processPath =
      this.configService.get<string>('KUATIA_OCR_PROCESS_PATH') ??
      '/ocr/process';

    const configuredToken = this.configService.get<string>(
      'KUATIA_OCR_API_TOKEN',
    );
    this.apiToken =
      configuredToken && configuredToken.trim().length > 0
        ? configuredToken.trim()
        : null;
  }

  async processDocument(
    request: ProcessWithOcrRequest,
  ): Promise<Record<string, unknown>> {
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}${this.normalizePath(this.processPath)}`;
    const filePayload = await this.resolveDocumentFile(request.documento);
    const formData = new FormData();
    const fileName = this.buildFileName(
      request.documentId,
      filePayload.mimeType,
    );

    formData.append(
      'file',
      new Blob([new Uint8Array(filePayload.buffer)], {
        type: filePayload.mimeType,
      }),
      fileName,
    );
    formData.append('empresaId', String(request.empresaId));
    formData.append('prompt', request.prompt);
    formData.append('documentId', String(request.documentId));

    const headers: Record<string, string> = {};
    if (this.apiToken) {
      headers['x-ocr-token'] = this.apiToken;
    }

    const response = await this.fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers,
        body: formData,
      },
      this.timeoutMs,
      `Tiempo de espera agotado al invocar OCR-KUATIA tras ${this.timeoutMs} ms.`,
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OCR-KUATIA respondio ${response.status}: ${errorBody.slice(0, 500)}`,
      );
    }

    const responseBody = (await response.json()) as unknown;
    return this.extractPayload(responseBody);
  }

  private extractPayload(payload: unknown): Record<string, unknown> {
    const asRecord = this.toRecord(payload);
    if (!asRecord) {
      throw new Error('Respuesta OCR invalida: no es un objeto JSON.');
    }

    const resultValue = asRecord.result;
    if (resultValue !== undefined) {
      if (typeof resultValue === 'string') {
        try {
          const parsed = JSON.parse(resultValue) as unknown;
          const parsedRecord = this.toRecord(parsed);
          if (parsedRecord) {
            return parsedRecord;
          }
        } catch {
          throw new Error(
            'Respuesta OCR invalida: "result" no contiene JSON parseable.',
          );
        }
      }

      const resultRecord = this.toRecord(resultValue);
      if (resultRecord) {
        return resultRecord;
      }
    }

    return asRecord;
  }

  private async resolveDocumentFile(
    rawDocumentValue: string,
  ): Promise<DocumentFilePayload> {
    const value = rawDocumentValue.trim();
    if (!value) {
      throw new Error('documento vacio para OCR.');
    }

    const dataUriMatch = value.match(/^data:([^;]+);base64,(.+)$/s);
    if (dataUriMatch) {
      const [, mimeType, base64Data] = dataUriMatch;
      return {
        mimeType,
        buffer: Buffer.from(this.sanitizeBase64(base64Data), 'base64'),
      };
    }

    if (/^https?:\/\//i.test(value)) {
      const response = await this.fetchWithTimeout(
        value,
        undefined,
        this.downloadTimeoutMs,
        `Tiempo de espera agotado al descargar documento URL tras ${this.downloadTimeoutMs} ms.`,
      );
      if (!response.ok) {
        throw new Error(`No se pudo descargar documento URL (${response.status})`);
      }

      const contentType = (response.headers.get('content-type') ?? 'application/pdf')
        .split(';')[0]
        .trim();
      const buffer = Buffer.from(await response.arrayBuffer());

      return {
        mimeType: contentType,
        buffer,
      };
    }

    if (await this.pathExists(value)) {
      const buffer = await readFile(value);
      return {
        mimeType: this.guessMimeTypeFromPath(value),
        buffer,
      };
    }

    if (this.looksLikeBase64(value)) {
      return {
        mimeType: 'application/pdf',
        buffer: Buffer.from(this.sanitizeBase64(value), 'base64'),
      };
    }

    throw new Error('Formato de documento no soportado para OCR-KUATIA.');
  }

  private buildFileName(documentId: number, mimeType: string): string {
    const extension = this.mimeTypeToExtension(mimeType);
    return `document-${documentId}${extension}`;
  }

  private mimeTypeToExtension(mimeType: string): string {
    const normalized = mimeType.toLowerCase();
    if (normalized === 'application/pdf') {
      return '.pdf';
    }
    if (normalized === 'image/png') {
      return '.png';
    }
    if (normalized === 'image/webp') {
      return '.webp';
    }
    if (normalized === 'image/gif') {
      return '.gif';
    }
    if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
      return '.jpg';
    }
    return '.bin';
  }

  private normalizePath(pathValue: string): string {
    if (!pathValue.startsWith('/')) {
      return `/${pathValue}`;
    }
    return pathValue;
  }

  private sanitizeBase64(value: string): string {
    return value.replace(/\s/g, '');
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit | undefined,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<Response> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: abortController.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(timeoutMessage);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private looksLikeBase64(value: string): boolean {
    if (value.length < 32) {
      return false;
    }
    return /^[A-Za-z0-9+/=\s]+$/.test(value);
  }

  private async pathExists(pathValue: string): Promise<boolean> {
    try {
      await access(pathValue, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private guessMimeTypeFromPath(pathValue: string): string {
    const extension = extname(pathValue).toLowerCase();
    if (extension === '.pdf') {
      return 'application/pdf';
    }
    if (extension === '.png') {
      return 'image/png';
    }
    if (extension === '.webp') {
      return 'image/webp';
    }
    if (extension === '.gif') {
      return 'image/gif';
    }
    if (extension === '.jpg' || extension === '.jpeg') {
      return 'image/jpeg';
    }
    return 'application/octet-stream';
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
