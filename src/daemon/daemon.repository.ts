import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import {
  DocumentToProcess,
  PreparedOcrPayload,
  PromptRow,
} from './daemon.types';

interface PersistResult {
  partnerCreated: boolean;
  partnerId: number | null;
}

interface IdRow {
  sn_id: unknown;
}

interface DocumentIdRow {
  id: unknown;
}

interface ColumnNameRow {
  column_name: string;
}

type PendingDocumentsSource = 'unknown' | 'view' | 'table';

@Injectable()
export class DaemonRepository {
  private readonly schema: string;
  private readonly columnsCacheMs: number;
  private readonly pendingStatuses: string[];

  private documentColumnsCache: string[] = [];
  private documentColumnsCacheAt = 0;

  private promptFilterColumnsCache: Set<string> | null = null;
  private promptFilterColumnsCacheAt = 0;

  private pendingDocumentsSource: PendingDocumentsSource = 'unknown';

  private readonly protectedColumns = new Set<string>([
    'id',
    'emp_id',
    'usr_id',
    'doc_documento',
    'doc_estado',
    'doc_fecha_carga',
    'fecha_creacion',
    'fecha_modificacion',
  ]);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    const configuredSchema =
      this.configService.get<string>('DB_SCHEMA') ?? 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(configuredSchema)) {
      throw new Error(`DB_SCHEMA invalido: ${configuredSchema}`);
    }
    this.schema = configuredSchema;

    const configuredCacheMs = Number(
      this.configService.get<string>('OCR_DOCUMENT_COLUMNS_CACHE_MS') ??
        300000,
    );
    this.columnsCacheMs =
      Number.isFinite(configuredCacheMs) && configuredCacheMs >= 0
        ? Math.floor(configuredCacheMs)
        : 300000;

    this.pendingStatuses = this.parsePendingStatuses(
      this.configService.get<string>('OCR_PENDING_STATUSES'),
    );
  }

  async fetchPendingDocuments(limit: number): Promise<DocumentToProcess[]> {
    if (this.pendingDocumentsSource !== 'table') {
      try {
        const rows = await this.fetchPendingDocumentsFromView(limit);
        this.pendingDocumentsSource = 'view';
        return rows;
      } catch (error) {
        if (!this.isUndefinedRelationError(error)) {
          throw error;
        }
        this.pendingDocumentsSource = 'table';
      }
    }

    return this.fetchPendingDocumentsFromTable(limit);
  }

  async findLatestActivePrompt(): Promise<PromptRow | null> {
    const promptFilters = await this.buildPromptFilters();
    const whereClause =
      promptFilters.length > 0 ? `WHERE ${promptFilters.join(' AND ')}` : '';

    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id, prompt
      FROM ${this.schema}.lk_prompts
      ${whereClause}
      ORDER BY id DESC
      LIMIT 1
      `,
    );

    const rows = this.asArray<PromptRow>(rawRows);
    return rows[0] ?? null;
  }

  async getDocumentUpdatableColumns(): Promise<Set<string>> {
    const now = Date.now();
    const canReuseCache =
      this.documentColumnsCache.length > 0 &&
      now - this.documentColumnsCacheAt <= this.columnsCacheMs;

    if (canReuseCache) {
      return new Set(this.documentColumnsCache);
    }

    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'lk_documentos'
      ORDER BY ordinal_position ASC
      `,
      [this.schema],
    );
    const rows = this.asArray<ColumnNameRow>(rawRows);

    const columns = rows
      .map((row) => String(row.column_name || '').trim())
      .filter(
        (columnName) =>
          columnName.length > 0 && !this.protectedColumns.has(columnName),
      );

    this.documentColumnsCache = columns;
    this.documentColumnsCacheAt = now;

    return new Set(columns);
  }

  async persistProcessedDocument(
    documentId: number,
    ocrData: PreparedOcrPayload,
    processedStatus = 'procesado',
  ): Promise<PersistResult> {
    return this.dataSource.transaction(async (manager) => {
      const updateEntries = Object.entries(ocrData.documentUpdates).filter(
        ([, value]) => value !== undefined,
      );

      if (updateEntries.length === 0) {
        throw new Error('No hay campos OCR validos para actualizar.');
      }

      const businessPartner = await this.ensureBusinessPartner(
        manager,
        ocrData.providerFiscalId,
        ocrData.providerName,
      );

      const assignments: string[] = [];
      const values: unknown[] = [];

      for (const [columnName, value] of updateEntries) {
        values.push(value);
        assignments.push(
          `${this.quoteIdentifier(columnName)} = $${values.length}`,
        );
      }

      values.push(processedStatus);
      assignments.push(`doc_estado = $${values.length}`);
      assignments.push(`fecha_modificacion = NOW()`);
      values.push(documentId);

      const updatedRawRows: unknown = await manager.query(
        `
        UPDATE ${this.schema}.lk_documentos
        SET ${assignments.join(', ')}
        WHERE id = $${values.length}
        RETURNING id
        `,
        values,
      );
      const updatedRows = this.asArray<{ id: unknown }>(updatedRawRows);

      if (updatedRows.length === 0) {
        throw new Error(`No existe lk_documentos.id=${documentId}`);
      }

      return businessPartner;
    });
  }

  async findExistingDocumentIdByInvoiceNumberAndRuc(
    companyId: number,
    documentId: number,
    invoiceNumber: string,
    partnerFiscalId: string,
  ): Promise<number | null> {
    const cleanedInvoiceNumber = invoiceNumber.trim();
    const cleanedPartnerFiscalId = partnerFiscalId.trim();
    if (!cleanedInvoiceNumber || !cleanedPartnerFiscalId) {
      return null;
    }

    const normalizedDigits = this.onlyDigits(cleanedInvoiceNumber);
    const normalizedPartnerDigits = this.onlyDigits(cleanedPartnerFiscalId);
    const values: unknown[] = [
      companyId,
      documentId,
      cleanedInvoiceNumber,
      cleanedPartnerFiscalId,
    ];
    let invoicePredicate = `BTRIM(doc_numero) = $3`;
    let partnerPredicate = `BTRIM(sn_ruc) = $4`;

    if (normalizedDigits) {
      values.push(normalizedDigits);
      invoicePredicate = `(${invoicePredicate} OR regexp_replace(doc_numero, '[^0-9]', '', 'g') = $${values.length})`;
    }

    if (normalizedPartnerDigits) {
      values.push(normalizedPartnerDigits);
      partnerPredicate = `(${partnerPredicate} OR regexp_replace(sn_ruc, '[^0-9]', '', 'g') = $${values.length})`;
    }

    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id
      FROM ${this.schema}.lk_documentos
      WHERE emp_id = $1
        AND id <> $2
        AND doc_numero IS NOT NULL
        AND BTRIM(doc_numero) <> ''
        AND sn_ruc IS NOT NULL
        AND BTRIM(sn_ruc) <> ''
        AND ${invoicePredicate}
        AND ${partnerPredicate}
      ORDER BY id ASC
      LIMIT 1
      `,
      values,
    );

    const rows = this.asArray<DocumentIdRow>(rawRows);
    return this.toNumericId(rows[0]?.id);
  }

  async deleteDocumentById(documentId: number): Promise<boolean> {
    const rawRows: unknown = await this.dataSource.query(
      `
      DELETE FROM ${this.schema}.lk_documentos
      WHERE id = $1
      RETURNING id
      `,
      [documentId],
    );

    return this.asArray<DocumentIdRow>(rawRows).length > 0;
  }

  async setDocumentStatus(documentId: number, status: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE ${this.schema}.lk_documentos
      SET doc_estado = $1,
          fecha_modificacion = NOW()
      WHERE id = $2
      `,
      [status, documentId],
    );
  }

  private async fetchPendingDocumentsFromView(
    limit: number,
  ): Promise<DocumentToProcess[]> {
    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id, emp_id, doc_documento
      FROM ${this.schema}.v_documentos_a_procesar
      ORDER BY id ASC
      LIMIT $1
      `,
      [limit],
    );

    return this.asArray<DocumentToProcess>(rawRows);
  }

  private async fetchPendingDocumentsFromTable(
    limit: number,
  ): Promise<DocumentToProcess[]> {
    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT id, emp_id, doc_documento
      FROM ${this.schema}.lk_documentos
      WHERE doc_documento IS NOT NULL
        AND BTRIM(doc_documento) <> ''
        AND LOWER(BTRIM(COALESCE(doc_estado, ''))) = ANY($1::text[])
      ORDER BY id ASC
      LIMIT $2
      `,
      [this.pendingStatuses, limit],
    );

    return this.asArray<DocumentToProcess>(rawRows);
  }

  private async buildPromptFilters(): Promise<string[]> {
    const columns = await this.getPromptFilterColumns();
    const filters: string[] = [];

    if (columns.has('active')) {
      filters.push('active = true');
    }
    if (columns.has('habilitado')) {
      filters.push('habilitado = true');
    }
    if (columns.has('enabled')) {
      filters.push('enabled = true');
    }

    return filters;
  }

  private async getPromptFilterColumns(): Promise<Set<string>> {
    const now = Date.now();
    const canReuseCache =
      this.promptFilterColumnsCache &&
      now - this.promptFilterColumnsCacheAt <= this.columnsCacheMs;
    if (canReuseCache) {
      return new Set(this.promptFilterColumnsCache);
    }

    const rawRows: unknown = await this.dataSource.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'lk_prompts'
        AND column_name IN ('active', 'habilitado', 'enabled')
      `,
      [this.schema],
    );
    const rows = this.asArray<ColumnNameRow>(rawRows);
    const columnSet = new Set(
      rows
        .map((row) => String(row.column_name || '').trim().toLowerCase())
        .filter((columnName) => columnName.length > 0),
    );

    this.promptFilterColumnsCache = columnSet;
    this.promptFilterColumnsCacheAt = now;

    return new Set(columnSet);
  }

  private async ensureBusinessPartner(
    manager: EntityManager,
    fiscalId: string | null,
    providerName: string | null,
  ): Promise<PersistResult> {
    const normalizedFiscalId = (fiscalId ?? '').trim();
    if (!normalizedFiscalId) {
      return {
        partnerCreated: false,
        partnerId: null,
      };
    }

    const existingRawRows: unknown = await manager.query(
      `
      SELECT sn_id
      FROM ${this.schema}.lk_socios_negocios
      WHERE sn_ruc = $1
      LIMIT 1
      `,
      [normalizedFiscalId],
    );
    const existingRows = this.asArray<IdRow>(existingRawRows);

    const existingPartnerId = this.toNumericId(existingRows[0]?.sn_id);
    if (existingPartnerId !== null) {
      return {
        partnerCreated: false,
        partnerId: existingPartnerId,
      };
    }

    const insertedRawRows: unknown = await manager.query(
      `
      INSERT INTO ${this.schema}.lk_socios_negocios
      (
        sn_nombre,
        sn_ruc,
        sn_tipo,
        sn_activo,
        sn_fecha_creacion,
        sn_fecha_modificacion
      )
      VALUES
      (
        $1,
        $2,
        'P',
        true,
        NOW(),
        NOW()
      )
      RETURNING sn_id
      `,
      [this.resolveProviderName(providerName, normalizedFiscalId), normalizedFiscalId],
    );
    const insertedRows = this.asArray<IdRow>(insertedRawRows);
    const insertedPartnerId = this.toNumericId(insertedRows[0]?.sn_id);

    return {
      partnerCreated: true,
      partnerId: insertedPartnerId,
    };
  }

  private parsePendingStatuses(rawValue: string | undefined): string[] {
    const value = (rawValue ?? 'cargado').trim();
    const statuses = value
      .split(',')
      .map((status) => status.trim().toLowerCase())
      .filter((status, index, allStatuses) => {
        return status.length > 0 && allStatuses.indexOf(status) === index;
      });

    return statuses.length > 0 ? statuses : ['cargado'];
  }

  private isUndefinedRelationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const maybeCode = (error as { code?: unknown }).code;
    return maybeCode === '42P01';
  }

  private asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  private resolveProviderName(
    providerName: string | null,
    fallbackFiscalId: string,
  ): string {
    const cleanedName = (providerName ?? '').trim();
    return cleanedName.length > 0 ? cleanedName : fallbackFiscalId;
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private onlyDigits(value: string): string {
    return value.replace(/[^0-9]/g, '');
  }

  private toNumericId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }
}
