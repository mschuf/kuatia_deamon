import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { StepLoggerService } from '../logging/step-logger.service';
import { DaemonRepository } from './daemon.repository';
import { KuatiaOcrClient } from './kuatia-ocr.client';
import {
  DaemonCycleSummary,
  DocumentToProcess,
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
    private readonly kuatiaOcrClient: KuatiaOcrClient,
    private readonly stepLogger: StepLoggerService,
  ) {}

  getStatus(): Record<string, unknown> {
    return {
      service: 'kuatia-daemon',
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
    } finally {
      summary.finishedAt = new Date().toISOString();
      this.lastSummary = summary;
      this.isRunning = false;

      this.stepLogger.info('Ciclo del daemon finalizado.', {
        runId,
        step: 'cycle.finish',
        metadata: summary,
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
        return {
          status: 'skipped',
          partnerCreated: false,
        };
      }

      const composedPrompt = this.composePrompt(globalPrompt.prompt);

      this.stepLogger.debug('Enviando documento a OCR-KUATIA.', {
        ...contextBase,
        step: 'doc.send_ocr',
        metadata: {
          documentLength: document.doc_documento.length,
          promptId: globalPrompt.id,
        },
      });

      const rawOcrData = await this.kuatiaOcrClient.processDocument({
        documento: document.doc_documento,
        empresaId: document.emp_id,
        prompt: composedPrompt,
        documentId: document.id,
      });

      this.stepLogger.debug('Respuesta OCR recibida desde OCR-KUATIA.', {
        ...contextBase,
        step: 'doc.ocr_response',
        metadata: {
          responseKeys: Object.keys(rawOcrData),
        },
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

        return {
          status: 'failed',
          partnerCreated: false,
        };
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
