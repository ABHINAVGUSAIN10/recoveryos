import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { PrismaService } from './prisma.service';
import { RecoveryService } from './recovery.service';
import { AiService } from './ai.service';
import { RazorpayService } from './razorpay.service';
import { RecoveryProcessor } from './recovery.processor';
import { TokenAuthGuard } from './auth.guard';
import { RequestLoggingMiddleware } from './request-logging.middleware';
import { validateEnvironment } from './environment';
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'], validate: validateEnvironment }), BullModule.forRootAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => ({ connection: { url: c.get<string>('REDIS_URL', 'redis://localhost:6379') } }) }), BullModule.registerQueue({ name: 'recovery' })],
  controllers: [AppController], providers: [PrismaService, RecoveryService, AiService, RazorpayService, RecoveryProcessor, RequestLoggingMiddleware, { provide: APP_GUARD, useClass: TokenAuthGuard }],
}) export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(RequestLoggingMiddleware).forRoutes('*'); }
}
