import { Module } from '@nestjs/common';
import { DaemonController } from './daemon.controller';
import { DaemonRepository } from './daemon.repository';
import { DaemonSchedulerService } from './daemon-scheduler.service';
import { KuatrixOcrClient } from './kuatrix-ocr.client';
import { OcrDaemonService } from './ocr-daemon.service';

@Module({
  controllers: [DaemonController],
  providers: [
    DaemonRepository,
    DaemonSchedulerService,
    KuatrixOcrClient,
    OcrDaemonService,
  ],
  exports: [OcrDaemonService],
})
export class DaemonModule {}
