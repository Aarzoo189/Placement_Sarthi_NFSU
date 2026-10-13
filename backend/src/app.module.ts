import { Controller, Get, Module } from '@nestjs/common';
import { Public } from './common/decorators';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { JobsModule } from './jobs/jobs.module';
import { DomainModule } from './domain.module';
import { StudentsController } from './students/students.controller';
import { DrivesController } from './drives/drives.controller';
import { OffersController } from './offers/offers.controller';
import { ComplianceController } from './compliance/compliance.controller';
import { DashboardsController } from './dashboards/dashboards.controller';
import { ExportsController } from './exports/exports.controller';
import { AdminController } from './admin/admin.controller';

@Controller('health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [CommonModule, AuthModule, DomainModule, ...(process.env.DISABLE_JOBS === 'true' ? [] : [JobsModule])],
  controllers: [HealthController, StudentsController, DrivesController, OffersController, ComplianceController, DashboardsController, ExportsController, AdminController],
})
export class AppModule {}
