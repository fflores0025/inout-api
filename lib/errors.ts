/**
 * Error controlado de la API: se traduce a una respuesta JSON con el status indicado.
 * Sin dependencias de Next para poder usarlo también en tests.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    Object.setPrototypeOf(this, ApiError.prototype)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}
