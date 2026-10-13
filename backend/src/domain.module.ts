import { Module } from '@nestjs/common';
import { PolicyService } from './policy/policy.service';
import { EngineService } from './policy/engine.service';
import { UsersService } from './users/users.service';
import { StudentsService } from './students/students.service';
import { DrivesService } from './drives/drives.service';
import { OffersService } from './offers/offers.service';
import { AttendanceService } from './compliance/attendance.service';
import { ExceptionsService } from './compliance/exceptions.service';
import { ReviewService } from './compliance/review.service';
import { DashboardsService } from './dashboards/dashboards.service';
import { ExportsService } from './exports/exports.service';
import { SystemService } from './admin/system.service';

const services = [PolicyService, EngineService, UsersService, StudentsService, DrivesService, OffersService, AttendanceService, ExceptionsService, ReviewService, DashboardsService, ExportsService, SystemService];

/** All domain services in one place so controllers and the background-job module share the same instances. */
@Module({ providers: services, exports: services })
export class DomainModule {}
