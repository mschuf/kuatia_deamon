import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { StepLoggerService } from '../logging/step-logger.service';
import { DaemonRepository } from './daemon.repository';
import { KuatrixOcrClient } from './kuatrix-ocr.client';
import {
  DaemonCycleSummary,
  DocumentToProcess,
  PreparedOcrPayload,
  PromptRow,
} from './daemon.types';
import { normalizeOcrPayload } from './ocr-normalizer';

interface RunCycleOptions {
  limit?: number;
}

type ProcessResultStatus = 'updated' | 'failed' | 'skipped';

interface ProcessResult {
  status: ProcessResultStatus;
  partnerCreated: boolean;
}

@Injectable()
export class OcrDaemonService {
  private isRunning = false;
  private lastSummary: DaemonCycleSummary | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly daemonRepository: DaemonRepository,
    private readonly kuatrixOcrClient: KuatrixOcrClient,
    private readonly stepLogger: StepLoggerService,
  ) {}

  getStatus(): Record<string, unknown> {
    return {
      service: 'kuatrix-daemon',
      running: this.isRunning,
      intervalMinutes: this.intervalMinutes,
      defaultBatchSize: this.defaultBatchSize,
      lastSummary: this.lastSummary,
      timestamp: new Date().toISOString(),
    };
  }

  async runCycle(
    trigger: 'startup' | 'schedule' | 'manual',
    options: RunCycleOptions = {},
  ): Promise<DaemonCycleSummary> {
    if (this.isRunning) {
      const activeRunId = this.lastSummary?.runId ?? 'run-in-progress';
      this.stepLogger.warn('Se omite ciclo porque ya hay otro en ejecucion.', {
        runId: activeRunId,
        step: 'cycle.guard',
        metadata: {
          trigger,
        },
      });

      return this.lastSummary ?? this.emptySummary(trigger);
    }

    const runId = randomUUID();
    this.isRunning = true;
    const startedAt = new Date().toISOString();

    const summary: DaemonCycleSummary = {
      runId,
      trigger,
      startedAt,
      totalFound: 0,
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      partnersCreated: 0,
    };

    this.lastSummary = summary;

    this.stepLogger.info('Iniciando ciclo de daemon OCR.', {
      runId,
      step: 'cycle.start',
      metadata: {
        trigger,
        limitOverride: options.limit ?? null,
      },
    });
    await this.safeProcesoLog({
      runId,
      origen: 'daemon',
      nivel: 'info',
      evento: 'cycle.start',
      mensaje: 'Iniciando ciclo de daemon OCR.',
      payload: {
        trigger,
        limitOverride: options.limit ?? null,
      },
    });

    try {
      const limit = this.resolveBatchLimit(options.limit);
      const globalPrompt = await this.loadLatestPrompt(runId);
      const updatableColumns =
        await this.daemonRepository.getDocumentUpdatableColumns();
      const pendingDocuments =
        await this.daemonRepository.fetchPendingDocuments(limit);
      summary.totalFound = pendingDocuments.length;

      this.stepLogger.info('Documentos pendientes obtenidos.', {
        runId,
        step: 'cycle.fetch_pending',
        metadata: {
          count: pendingDocuments.length,
          limit,
          updatableColumnsCount: updatableColumns.size,
          hasPrompt: Boolean(globalPrompt),
          promptId: globalPrompt?.id ?? null,
        },
      });
      await this.safeProcesoLog({
        runId,
        origen: 'daemon',
        nivel: 'info',
        evento: 'cycle.fetch_pending',
        mensaje: 'Documentos pendientes obtenidos.',
        payload: {
          count: pendingDocuments.length,
          limit,
          updatableColumnsCount: updatableColumns.size,
          hasPrompt: Boolean(globalPrompt),
          promptId: globalPrompt?.id ?? null,
        },
      });

      for (const document of pendingDocuments) {
        summary.processed += 1;
        const result = await this.processDocument(
          runId,
          document,
          globalPrompt,
          updatableColumns,
        );

        if (result.status === 'updated') {
          summary.updated += 1;
        } else if (result.status === 'skipped') {
          summary.skipped += 1;
        } else {
          summary.failed += 1;
        }

        if (result.partnerCreated) {
          summary.partnersCreated += 1;
        }
      }
    } catch (error) {
      summary.failed += 1;
      this.stepLogger.error(
        'Error general durante el ciclo del daemon.',
        {
          runId,
          step: 'cycle.error',
        },
        error,
      );
      await this.safeProcesoLog({
        runId,
        origen: 'daemon',
        nivel: 'error',
        evento: 'cycle.error',
        mensaje: 'Error general durante el ciclo del daemon.',
        payload: this.serializeError(error),
      });
    } finally {
      summary.finishedAt = new Date().toISOString();
      this.lastSummary = summary;
      this.isRunning = false;

      this.stepLogger.info('Ciclo del daemon finalizado.', {
        runId,
        step: 'cycle.finish',
        metadata: summary,
      });
      await this.safeProcesoLog({
        runId,
        origen: 'daemon',
        nivel: 'info',
        evento: 'cycle.finish',
        mensaje: 'Ciclo del daemon finalizado.',
        payload: summary,
      });
    }

    return summary;
  }

  validateControlToken(token: string | undefined): void {
    const controlToken = this.configService.get<string>('DAEMON_CONTROL_TOKEN');
    if (!controlToken) {
      return;
    }

    if (!token || token !== controlToken) {
      throw new UnauthorizedException(
        'Token de control invalido para ejecucion manual del daemon.',
      );
    }
  }

  get intervalMinutes(): number {
    const configuredValue = Number(
      this.configService.get<string>('OCR_DAEMON_INTERVAL_MINUTES') ?? 5,
    );
    return Number.isFinite(configuredValue) && configuredValue >= 1
      ? configuredValue
      : 5;
  }

  get defaultBatchSize(): number {
    const configuredValue = Number(
      this.configService.get<string>('OCR_DAEMON_BATCH_SIZE') ?? 20,
    );

    if (!Number.isFinite(configuredValue)) {
      return 20;
    }

    return Math.max(1, Math.min(200, Math.floor(configuredValue)));
  }

  private async processDocument(
    runId: string,
    document: DocumentToProcess,
    globalPrompt: PromptRow | null,
    updatableColumns: Set<string>,
  ): Promise<ProcessResult> {
    const contextBase = {
      runId,
      documentId: document.id,
      companyId: document.emp_id,
    };

    try {
      this.stepLogger.info('Iniciando procesamiento de documento.', {
        ...contextBase,
        step: 'doc.start',
      });
      await this.safeProcesoLog({
        runId,
        empId: document.emp_id,
        documentoId: document.id,
        origen: 'daemon',
        nivel: 'info',
        evento: 'doc.start',
        mensaje: 'Iniciando procesamiento de documento.',
      });

      if (!document.doc_documento) {
        await this.safeSetDocumentStatus(
          document.id,
          this.statusWithoutDocument,
          contextBase,
        );
        this.stepLogger.error('Documento sin contenido para OCR.', {
          ...contextBase,
          step: 'doc.validate_content',
        });
        await this.safeProcesoLog({
          runId,
          empId: document.emp_id,
          documentoId: document.id,
          origen: 'daemon',
          nivel: 'error',
          evento: 'doc.validate_content',
          mensaje: 'Documento sin contenido para OCR.',
          payload: { status: this.statusWithoutDocument },
        });
        return {
          status: 'skipped',
          partnerCreated: false,
        };
      }

      if (!globalPrompt) {
        await this.safeSetDocumentStatus(
          document.id,
          this.statusWithoutPrompt,
          contextBase,
        );
        this.stepLogger.error(
          'No existe prompt activo/habilitado para ejecutar OCR.',
          {
            ...contextBase,
            step: 'doc.prompt',
          },
        );
        await this.safeProcesoLog({
          runId,
          empId: document.emp_id,
          documentoId: document.id,
          origen: 'daemon',
          nivel: 'error',
          evento: 'doc.prompt',
          mensaje: 'No existe prompt activo/habilitado para ejecutar OCR.',
          payload: { status: this.statusWithoutPrompt },
        });
        return {
          status: 'skipped',
          partnerCreated: false,
        };
      }

      const composedPrompt = this.composePrompt(globalPrompt.prompt);

      this.stepLogger.debug('Enviando documento a OCR-KUATRIX.', {
        ...contextBase,
        step: 'doc.send_ocr',
        metadata: {
          documentLength: document.doc_documento.length,
          promptId: globalPrompt.id,
        },
      });
      await this.safeProcesoLog({
        runId,
        empId: document.emp_id,
        documentoId: document.id,
        origen: 'daemon',
        nivel: 'debug',
        evento: 'doc.send_ocr',
        mensaje: 'Enviando documento a OCR-KUATRIX.',
        payload: {
          documentLength: document.doc_documento.length,
          promptId: globalPrompt.id,
        },
      });

      const rawOcrData = await this.kuatrixOcrClient.processDocument({
        documento: document.doc_documento,
        empresaId: document.emp_id,
        prompt: composedPrompt,
        documentId: document.id,
      });

      this.stepLogger.debug('Respuesta OCR recibida desde OCR-KUATRIX.', {
        ...contextBase,
        step: 'doc.ocr_response',
        metadata: {
          responseKeys: Object.keys(rawOcrData),
        },
      });
      await this.safeProcesoLog({
        runId,
        empId: document.emp_id,
        documentoId: document.id,
        origen: 'daemon',
        nivel: 'info',
        evento: 'doc.ocr_response',
        mensaje: 'Respuesta OCR recibida desde OCR-KUATRIX.',
        payload: rawOcrData,
      });

      const normalizedData = normalizeOcrPayload(rawOcrData, updatableColumns);
      const updateFields = Object.keys(normalizedData.documentUpdates);

      if (updateFields.length === 0) {
        await this.safeSetDocumentStatus(
          document.id,
          this.statusIncomplete,
          contextBase,
        );
        this.stepLogger.error(
          'OCR sin campos validos para actualizar lk_documentos.',
          {
            ...contextBase,
            step: 'doc.validate_output',
            metadata: {
              ignoredFields: normalizedData.ignoredFields,
              responseKeys: Object.keys(rawOcrData),
            },
          },
        );
        await this.safeProcesoLog({
          runId,
          empId: document.emp_id,
          documentoId: document.id,
          origen: 'daemon',
          nivel: 'error',
          evento: 'doc.validate_output',
          mensaje: 'OCR sin campos validos para actualizar lk_documentos.',
          payload: {
            ignoredFields: normalizedData.ignoredFields,
            responseKeys: Object.keys(rawOcrData),
            rawOcrData,
          },
        });

        return {
          status: 'failed',
          partnerCreated: false,
        };
      }

      const invoiceNumber = this.getInvoiceNumberFromOcr(normalizedData);
      const partnerFiscalId = this.getPartnerFiscalIdFromOcr(normalizedData);
      if (invoiceNumber && partnerFiscalId) {
        const duplicateDocumentId =
          await this.daemonRepository.findExistingDocumentIdByInvoiceNumberAndRuc(
            document.emp_id,
            document.id,
            invoiceNumber,
            partnerFiscalId,
          );

        if (duplicateDocumentId !== null) {
          await this.daemonRepository.deleteDocumentById(document.id);
          this.stepLogger.warn(
            'Factura duplicada detectada; se elimino el documento ingresado por segunda vez.',
            {
              ...contextBase,
              step: 'doc.duplicate_invoice',
              metadata: {
                invoiceNumber,
                partnerFiscalId,
                duplicateDocumentId,
                updatedFields: updateFields,
                providerFiscalId: normalizedData.providerFiscalId,
                aliasesApplied: normalizedData.aliasesApplied,
              },
            },
          );
          await this.safeProcesoLog({
            runId,
            empId: document.emp_id,
            documentoId: document.id,
            origen: 'daemon',
            nivel: 'warn',
            evento: 'doc.duplicate_invoice',
            mensaje:
              'Factura duplicada detectada; se elimino el documento ingresado por segunda vez.',
            payload: {
              invoiceNumber,
              partnerFiscalId,
              duplicateDocumentId,
              updatedFields: updateFields,
              providerFiscalId: normalizedData.providerFiscalId,
              aliasesApplied: normalizedData.aliasesApplied,
            },
          });

          return {
            status: 'skipped',
            partnerCreated: false,
          };
        }
      } else if (invoiceNumber) {
        this.stepLogger.debug(
          'No se valida duplicado porque OCR no devolvio sn_ruc.',
          {
            ...contextBase,
            step: 'doc.duplicate_invoice_missing_ruc',
            metadata: {
              invoiceNumber,
              updatedFields: updateFields,
              aliasesApplied: normalizedData.aliasesApplied,
            },
          },
        );
      }

      const persistResult = await this.daemonRepository.persistProcessedDocument(
        document.id,
        normalizedData,
        this.statusProcessed,
      );

      this.stepLogger.info(
        'Documento actualizado correctamente en base de datos.',
        {
          ...contextBase,
          step: 'doc.persist',
          metadata: {
            partnerCreated: persistResult.partnerCreated,
            partnerId: persistResult.partnerId,
            updatedFields: updateFields,
            providerFiscalId: normalizedData.providerFiscalId,
            aliasesApplied: normalizedData.aliasesApplied,
            ignoredFields: normalizedData.ignoredFields,
          },
        },
      );
      await this.safeProcesoLog({
        runId,
        empId: document.emp_id,
        documentoId: document.id,
        origen: 'daemon',
        nivel: 'info',
        evento: 'doc.persist',
        mensaje: 'Documento actualizado correctamente en base de datos.',
        payload: {
          partnerCreated: persistResult.partnerCreated,
          partnerId: persistResult.partnerId,
          updatedFields: updateFields,
          providerFiscalId: normalizedData.providerFiscalId,
          aliasesApplied: normalizedData.aliasesApplied,
          ignoredFields: normalizedData.ignoredFields,
        },
      });

      return {
        status: 'updated',
        partnerCreated: persistResult.partnerCreated,
      };
    } catch (error) {
      await this.safeSetDocumentStatus(document.id, this.statusError, contextBase);
      this.stepLogger.error(
        'Error procesando documento.',
        {
          ...contextBase,
          step: 'doc.error',
        },
        error,
      );
      await this.safeProcesoLog({
        runId,
        empId: document.emp_id,
        documentoId: document.id,
        origen: 'daemon',
        nivel: 'error',
        evento: 'doc.error',
        mensaje: 'Error procesando documento.',
        payload: this.serializeError(error),
      });

      return {
        status: 'failed',
        partnerCreated: false,
      };
    }
  }

  private async safeSetDocumentStatus(
    documentId: number,
    status: string,
    context: { runId: string; documentId: number; companyId: number },
  ): Promise<void> {
    try {
      await this.daemonRepository.setDocumentStatus(documentId, status);
    } catch (error) {
      this.stepLogger.warn('No se pudo actualizar doc_estado tras error.', {
        ...context,
        step: 'doc.set_status_error',
        metadata: {
          attemptedStatus: status,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async safeProcesoLog(input: {
    empId?: number | null;
    documentoId?: number | null;
    origen: string;
    nivel?: 'debug' | 'info' | 'warn' | 'error';
    evento: string;
    mensaje?: string | null;
    payload?: unknown;
    runId?: string | null;
  }): Promise<void> {
    try {
      await this.daemonRepository.insertProcesoLog(input);
    } catch (error) {
      this.stepLogger.warn('No se pudo guardar log de proceso en base.', {
        runId: input.runId ?? 'unknown',
        documentId: input.documentoId ?? undefined,
        companyId: input.empId ?? undefined,
        step: 'log.persist_error',
        metadata: {
          evento: input.evento,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return {
      message: String(error),
    };
  }

  private composePrompt(globalPrompt: string): string {
    const strictOutputInstructions = `
INSTRUCCIONES OBLIGATORIAS DE SALIDA:
- Responde exclusivamente con JSON valido.
- No incluyas markdown, ni explicaciones, ni texto adicional.
- Usa nombres de campos que existan en la tabla lk_documentos.
- Si no detectas un dato, omite la clave (no inventes valores).
- Puedes incluir sn_name para indicar el nombre del proveedor cuando se deba crear el socio de negocio.
`;

    return `${globalPrompt}\n\n${strictOutputInstructions}`;
  }

  private getInvoiceNumberFromOcr(
    normalizedData: PreparedOcrPayload,
  ): string | null {
    const invoiceNumber = normalizedData.documentUpdates.doc_numero;

    if (typeof invoiceNumber === 'string') {
      const trimmed = invoiceNumber.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (typeof invoiceNumber === 'number' || typeof invoiceNumber === 'bigint') {
      return String(invoiceNumber);
    }

    return null;
  }

  private getPartnerFiscalIdFromOcr(
    normalizedData: PreparedOcrPayload,
  ): string | null {
    const partnerFiscalId =
      normalizedData.documentUpdates.sn_ruc ?? normalizedData.providerFiscalId;

    if (typeof partnerFiscalId === 'string') {
      const trimmed = partnerFiscalId.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (
      typeof partnerFiscalId === 'number' ||
      typeof partnerFiscalId === 'bigint'
    ) {
      return String(partnerFiscalId);
    }

    return null;
  }

  private resolveBatchLimit(limitOverride: number | undefined): number {
    if (typeof limitOverride === 'number' && Number.isFinite(limitOverride)) {
      return Math.max(1, Math.min(200, Math.floor(limitOverride)));
    }

    return this.defaultBatchSize;
  }

  private async loadLatestPrompt(runId: string): Promise<PromptRow | null> {
    const prompt = await this.daemonRepository.findLatestActivePrompt();
    if (!prompt) {
      this.stepLogger.warn(
        'No se encontro un prompt activo/habilitado en lk_prompts.',
        {
          runId,
          step: 'cycle.prompt_lookup',
        },
      );
    }

    return prompt;
  }

  private get statusProcessed(): string {
    return this.resolveConfiguredStatus('OCR_STATUS_PROCESSED', 'procesado');
  }

  private get statusWithoutPrompt(): string {
    return this.resolveConfiguredStatus('OCR_STATUS_NO_PROMPT', 'error');
  }

  private get statusWithoutDocument(): string {
    return this.resolveConfiguredStatus('OCR_STATUS_NO_DOCUMENT', 'error');
  }

  private get statusIncomplete(): string {
    return this.resolveConfiguredStatus('OCR_STATUS_INCOMPLETE', 'error');
  }

  private get statusError(): string {
    return this.resolveConfiguredStatus('OCR_STATUS_ERROR', 'error');
  }

  private resolveConfiguredStatus(envKey: string, fallback: string): string {
    const rawValue = this.configService.get<string>(envKey);
    const cleaned = (rawValue ?? '').trim();
    return cleaned.length > 0 ? cleaned : fallback;
  }

  private emptySummary(
    trigger: 'startup' | 'schedule' | 'manual',
  ): DaemonCycleSummary {
    return {
      runId: randomUUID(),
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      totalFound: 0,
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      partnersCreated: 0,
    };
  }
}
