import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Put, Query, Req, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { beneficiaryRemediationSchema, policyConfigSchema } from '@recoveryos/domain';
import { RecoveryService } from './recovery.service';
import { Public, Roles, type AuthenticatedRequest } from './auth.guard';
import { RevenueRecoveryService } from './revenue-recovery.service';

type RawRequest = Request & { rawBody?: Buffer };
@Controller()
@Roles('VIEWER')
export class AppController {
  constructor(private readonly recovery: RecoveryService, private readonly revenue: RevenueRecoveryService) {}
  @Get('/session') session(@Req() req: AuthenticatedRequest) { return req.recoveryActor; }
  @Public()
  @Get('/health') health() { return this.recovery.health(); }
  @Public()
  @Get('/ready') readiness() { return this.recovery.readiness(); }
  @Public()
  @Post('/webhooks/razorpay') @HttpCode(202)
  async webhook(@Req() req: RawRequest, @Headers('x-razorpay-signature') signature: string | undefined, @Body() payload: any) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !signature) throw new UnauthorizedException('Webhook signature is required');
    const source = req.rawBody ?? Buffer.from(JSON.stringify(payload));
    const expected = createHmac('sha256', secret).update(source).digest('hex');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new UnauthorizedException('Invalid Razorpay webhook signature');
    const externalEventId = payload?.event_id ?? payload?.id ?? createHmac('sha256', secret).update(source).digest('hex');
    const eventType = payload?.event ?? 'payout.unknown';
    return String(eventType).startsWith('payment.')
      ? this.revenue.ingestPaymentWebhook(externalEventId, eventType, payload)
      : this.recovery.ingestWebhook(externalEventId, eventType, payload);
  }
  @Get('/incidents') incidents(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string, @Query('reviewRequired') reviewRequired?: string) {
    return this.recovery.listIncidents({ page: Number(page) || 1, pageSize: Number(pageSize) || 20, search, status, reviewRequired: reviewRequired === 'true' });
  }
  @Get('/incidents/:id') incident(@Param('id') id: string) { return this.recovery.incidentDetail(id); }
  @Roles('OPERATOR') @Post('/incidents/:id/approve') approve(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return this.recovery.decideReview(id, true, req.recoveryActor?.id); }
  @Roles('OPERATOR') @Post('/incidents/:id/reject') reject(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return this.recovery.decideReview(id, false, req.recoveryActor?.id); }
  @Roles('OPERATOR') @Post('/incidents/:id/remediate') remediate(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) { return this.recovery.remediateIncident(id, beneficiaryRemediationSchema.parse(body), req.recoveryActor?.id); }
  @Get('/policies') policy() { return this.recovery.getPolicy(); }
  @Get('/operations') operations() { return this.recovery.operations(); }
  @Roles('OPERATOR') @Post('/demo-runs') demoRun(@Req() req: AuthenticatedRequest, @Body('scenario') scenario?: string) { return this.recovery.runLiveDemo(scenario || 'ALL', req.recoveryActor?.id); }
  @Roles('ADMIN') @Post('/razorpayx-test-demo') razorpayTestDemo(@Req() req: AuthenticatedRequest, @Body('confirmation') confirmation?: string) { return this.recovery.runRazorpayTestDemo(confirmation || '', req.recoveryActor?.id); }
  @Roles('ADMIN') @Put('/policies') updatePolicy(@Req() req: AuthenticatedRequest, @Body() body: unknown) { return this.recovery.updatePolicy(policyConfigSchema.parse(body), req.recoveryActor?.id); }
  @Roles('OPERATOR') @Post('/batches') batch(@Body('name') name: string, @Body('incidentIds') incidentIds: string[]) { return this.recovery.createBatch(name || `Batch ${new Date().toISOString()}`, incidentIds || []); }
  @Get('/batches') batches() { return this.recovery.listBatches(); }
  @Get('/batches/:id/export.json') @Header('Content-Type', 'application/json; charset=utf-8')
  batchJson(@Param('id') id: string) { return this.recovery.batchResults(id); }
  @Get('/batches/:id/export.csv') @Header('Content-Type', 'text/csv; charset=utf-8')
  batchCsv(@Param('id') id: string) { return this.recovery.batchExportCsv(id); }
  @Get('/batches/:id') batchResults(@Param('id') id: string) { return this.recovery.batchResults(id); }
  @Roles('ADMIN') @Post('/reconcile') reconcile() { return this.recovery.reconcileOpen(); }
  @Get('/revenue/operations') revenueOperations() { return this.revenue.configuration(); }
  @Get('/revenue/incidents') revenueIncidents(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string) { return this.revenue.list({ page: Number(page) || 1, pageSize: Number(pageSize) || 20, search, status }); }
  @Get('/revenue/incidents/:id') revenueIncident(@Param('id') id: string) { return this.revenue.detail(id); }
  @Roles('OPERATOR') @Post('/revenue/incidents/:id/approve') approveRevenue(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return this.revenue.approve(id, req.recoveryActor?.id); }
  @Roles('OPERATOR') @Post('/revenue/incidents/:id/reject') rejectRevenue(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return this.revenue.reject(id, req.recoveryActor?.id); }
  @Roles('OPERATOR') @Post('/revenue/demo-runs') revenueDemo(@Req() req: AuthenticatedRequest) { return this.revenue.runDemo(req.recoveryActor?.id); }
  @Get('/revenue/experiments') revenueExperiments() { return this.revenue.listExperiments(); }
  @Get('/revenue/experiments/:id') revenueExperiment(@Param('id') id: string) { return this.revenue.experiment(id); }
}
