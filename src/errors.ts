import { type Error as MappedError } from '@prisma/driver-adapter-utils';
import { ConnectionLostError, DatabaseError } from 'postgrejs';

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_FORMAT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const SOCKET_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

interface SocketError {
  code: string;
  syscall: string;
  errno: number;
  address?: string;
  hostname?: string;
  port?: number;
}

/**
 * Turns whatever PostgreJS threw into the payload Prisma matches on.
 *
 * Rethrows anything it does not recognise: a `TypeError` from the adapter's own
 * code is a bug, and dressing it up as a database error would hide it.
 */
export function convertError(error: unknown): MappedError {
  if (error instanceof DatabaseError) {
    return {
      originalCode: error.code,
      // The undecorated text. `message` carries a caret diagram wherever the
      // server reported a position, and `serverMessage` is what PostgreSQL
      // actually sent - which is what the patterns below are written against
      // and what a user should see in a `P2010`.
      originalMessage: error.serverMessage,
      ...mapDatabaseError(error),
    };
  }

  if (error instanceof ConnectionLostError) {
    // The socket error, when there was one, says more than '08006' does.
    const cause = (error as { cause?: unknown }).cause;
    if (isSocketError(cause)) return mapSocketError(cause);
    return { kind: 'ConnectionClosed' };
  }

  if (isSocketError(error)) return mapSocketError(error);
  if (isTlsError(error)) {
    return { kind: 'TlsConnectionError', reason: (error as Error).message };
  }

  throw error;
}

function mapDatabaseError(error: DatabaseError): MappedError {
  // Every pattern here reads `serverMessage`, never `message`.
  const message = error.serverMessage;

  switch (error.code) {
    case '22001':
      return { kind: 'LengthMismatch', column: error.column };

    case '22003':
      return { kind: 'ValueOutOfRange', cause: message };

    case '22P02':
      return { kind: 'InvalidInputValue', message };

    case '23505': {
      const fields = keyFields(error.detail);
      let constraint: { fields: string[] } | { index: string } | undefined;
      if (error.constraint) constraint = { index: error.constraint };
      else if (fields) constraint = { fields };

      let table = error.table;
      if (table === undefined && fields && fields.length > 0) {
        const suffix = `_${fields.join('_')}_key`;
        if (error.constraint?.endsWith(suffix)) {
          table = error.constraint.slice(0, -suffix.length);
        }
      }
      return { kind: 'UniqueConstraintViolation', constraint, table };
    }

    case '23502': {
      const fields = keyFields(error.detail);
      return {
        kind: 'NullConstraintViolation',
        constraint: fields ? { fields } : undefined,
      };
    }

    case '23503':
      return {
        kind: 'ForeignKeyConstraintViolation',
        constraint: columnOrIndex(error),
      };

    case '23001':
      return { kind: 'RestrictViolation', constraint: columnOrIndex(error) };

    case '3D000':
      return { kind: 'DatabaseDoesNotExist', db: quoted(message, 1) };

    case '28000':
      return {
        kind: 'DatabaseAccessDenied',
        db: message
          .split(',')
          .find(s => s.startsWith(' database'))
          ?.split('"')
          .at(1),
      };

    case '28P01':
      return {
        kind: 'AuthenticationFailed',
        user: message.split(' ').pop()?.split('"').at(1),
      };

    case '40001':
    case '40P01':
      return { kind: 'TransactionWriteConflict' };

    case '42P01':
      return { kind: 'TableDoesNotExist', table: quoted(message, 1) };

    case '42703': {
      // Anchored, which is why it has to read serverMessage: the decorated
      // `message` has the source excerpt appended and would never match.
      const raw = message.match(/^column (.+) does not exist$/)?.at(1);
      return { kind: 'ColumnNotFound', column: raw ? unquote(raw) : undefined };
    }

    case '42P04':
      return { kind: 'DatabaseAlreadyExists', db: quoted(message, 1) };

    case '53300':
      return { kind: 'TooManyConnections', cause: message };

    case '08006':
      // PostgreJS synthesizes this for a connection that went away; the
      // server never sends it.
      return { kind: 'ConnectionClosed' };

    default:
      return {
        kind: 'postgres',
        code: error.code ?? 'N/A',
        severity: error.severity ?? 'N/A',
        message,
        detail: error.detail,
        column: error.column,
        hint: error.hint,
      };
  }
}

/** `Key (email)=(a@b.c) already exists.` -> `['email']` */
function keyFields(detail: string | undefined): string[] | undefined {
  return detail
    ?.match(/Key \(([^)]+)\)/)
    ?.at(1)
    ?.split(', ');
}

function columnOrIndex(
  error: DatabaseError,
): { fields: string[] } | { index: string } | undefined {
  if (error.column) return { fields: [error.column] };
  if (error.constraint) return { index: error.constraint };
  return undefined;
}

/** The nth space-separated word's quoted body - `relation "x" does not exist` -> `x`. */
function quoted(message: string, wordIndex: number): string | undefined {
  return message.split(' ').at(wordIndex)?.split('"').at(1);
}

function unquote(identifier: string): string {
  return identifier.replace(/"((?:""|[^"])*)"/g, (_, id: string) =>
    id.replaceAll('""', '"'),
  );
}

function isSocketError(error: unknown): error is SocketError {
  const e = error as Partial<SocketError> | null;
  return (
    !!e &&
    typeof e.code === 'string' &&
    typeof e.syscall === 'string' &&
    typeof e.errno === 'number' &&
    SOCKET_ERROR_CODES.has(e.code)
  );
}

function mapSocketError(error: SocketError): MappedError {
  switch (error.code) {
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
      return {
        kind: 'DatabaseNotReachable',
        host: error.address ?? error.hostname,
        port: error.port,
      };
    case 'ETIMEDOUT':
      return { kind: 'SocketTimeout' };
    default:
      return { kind: 'ConnectionClosed' };
  }
}

function isTlsError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (typeof e.code === 'string') return TLS_ERROR_CODES.has(e.code);
  return (
    e.message === 'The server does not support SSL connections' ||
    e.message === 'There was an error establishing an SSL connection'
  );
}
