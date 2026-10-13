import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodTypeAny, z } from 'zod';

/**
 * Schema validation on every request (architecture doc, section 8). Use with `@Body(new ZodPipe(schema))`.
 * Schemas are `.strict()` wherever the payload is a write: an unknown key (`placement_status`, `ctc`, ...) is a 400, never
 * silently dropped, so tampering attempts are visible rather than ignored.
 */
@Injectable()
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.infer<T> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw new BadRequestException({ message: 'Validation failed', errors: formatZod(r.error) });
    return r.data;
  }
}

export const formatZod = (e: ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

// ---- common field schemas ----
export const uuid = z.string().uuid();
export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);
export const indianMobile = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'must be a 10-digit Indian mobile number');
/** Free text: stored as plain text and output-encoded by React; control characters are stripped, length capped. */
export const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));

export const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
});
