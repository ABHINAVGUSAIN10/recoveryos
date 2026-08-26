import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    const maxAttempts = this.integerSetting('DATABASE_CONNECT_MAX_ATTEMPTS', 5, 1, 20);
    const initialDelayMs = this.integerSetting('DATABASE_CONNECT_RETRY_MS', 1_000, 1, 30_000);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        const delayMs = Math.min(initialDelayMs * (2 ** (attempt - 1)), 30_000);
        this.logger.warn(`Database connection attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms.`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  async onModuleDestroy() { await this.$disconnect(); }

  private integerSetting(name: string, fallback: number, minimum: number, maximum: number) {
    const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
    return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
  }
}
