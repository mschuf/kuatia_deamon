import { Module } from '@nestjs/common';
import { DaemonController } from './daemon.controller';
import { DaemonRepository } from './daemon.repository';
import { DaemonSchedulerService } from './daemon-scheduler.service';
import { KuatiaOcrClient } from './kuatia-ocr.client';
import { OcrDaemonService } from './ocr-daemon.service';

@Module({
  controllers: [DaemonController],
  providers: [
    DaemonRepository,
    DaemonSchedulerService,
    KuatiaOcrClient,
    OcrDaemonService,
  ],
  exports: [OcrDaemonService],
})
export class DaemonModule {}
