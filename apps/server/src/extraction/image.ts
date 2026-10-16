import { imageSize } from "image-size";

export type SupportedInvoiceMimeType = "image/png" | "image/jpeg";
export interface InvoiceImageLimits { maxBytes: number; maxPixels: number }
export const defaultInvoiceImageLimits: InvoiceImageLimits = { maxBytes: 5_000_000, maxPixels: 20_000_000 };

export interface ValidatedInvoiceImage {
  bytes: Uint8Array;
  mimeType: SupportedInvoiceMimeType;
  width: number;
  height: number;
}

function detectedMimeType(bytes: Uint8Array): SupportedInvoiceMimeType | null {
  const png = bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
  if (png) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export class InvoiceImageError extends Error {
  readonly code: "INVALID_IMAGE" | "INPUT_TOO_LARGE";
  readonly status: number;

  constructor(code: "INVALID_IMAGE" | "INPUT_TOO_LARGE", message: string, status = 400) {
    super(message);
    this.name = "InvoiceImageError";
    this.code = code;
    this.status = status;
  }
}

export function validateInvoiceImage(
  body: unknown,
  contentType: string | undefined,
  limits: { maxBytes: number; maxPixels: number }
): ValidatedInvoiceImage {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new InvoiceImageError("INVALID_IMAGE", "Send one PNG or JPEG as the request body");
  }
  if (body.length > limits.maxBytes) {
    throw new InvoiceImageError("INPUT_TOO_LARGE", "Invoice image exceeds the configured byte limit", 413);
  }

  const declaredMimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const actualMimeType = detectedMimeType(body);
  if ((declaredMimeType !== "image/png" && declaredMimeType !== "image/jpeg") || actualMimeType !== declaredMimeType) {
    throw new InvoiceImageError("INVALID_IMAGE", "Content-Type and file signature must identify the same PNG or JPEG");
  }

  let dimensions;
  try {
    dimensions = imageSize(body);
  } catch {
    throw new InvoiceImageError("INVALID_IMAGE", "Invoice image could not be decoded");
  }
  if (!dimensions.width || !dimensions.height || dimensions.type !== (actualMimeType === "image/png" ? "png" : "jpg")) {
    throw new InvoiceImageError("INVALID_IMAGE", "Invoice image dimensions or format are invalid");
  }
  if (dimensions.width * dimensions.height > limits.maxPixels) {
    throw new InvoiceImageError("INPUT_TOO_LARGE", "Invoice image exceeds the configured pixel limit", 413);
  }

  return {
    bytes: body,
    mimeType: actualMimeType,
    width: dimensions.width,
    height: dimensions.height
  };
}
