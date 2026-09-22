import { expect } from 'expect';
import { ConnectionLostError, DatabaseError } from 'postgrejs';
import { convertError } from '../../src/errors.js';

/**
 * A `DatabaseError` as PostgreJS builds one - from the server's ErrorResponse,
 * with `message` then decorated by the connection wherever a position came
 * back. The decoration is what makes `serverMessage` load-bearing: an anchored
 * pattern on `message` can never match once the source excerpt is appended.
 */
function dbError(
  fields: Record<string, unknown>,
  decorate = true,
): DatabaseError {
  const error = new DatabaseError({
    message: 'placeholder',
    ...fields,
  } as never);
  Object.assign(error, fields);
  if (decorate && fields.position != null) {
    error.message = `${fields.message as string}\n    at line 1 column 8\n  1| select x\n    .-------^`;
  } else {
    error.message = fields.message as string;
  }
  return error;
}

describe('convertError()', () => {
  it('reads the undecorated text, not the decorated message', () => {
    const error = dbError({
      code: '42703',
      severity: 'ERROR',
      message: 'column "nosuchcol" does not exist',
      position: 8,
    });
    // The premise: message really is decorated, so this is not a tautology.
    expect(error.message).not.toStrictEqual(error.serverMessage);
    expect(error.message).toContain('at line 1 column 8');

    const mapped = convertError(error);
    expect(mapped).toMatchObject({
      kind: 'ColumnNotFound',
      column: 'nosuchcol',
      originalCode: '42703',
      originalMessage: 'column "nosuchcol" does not exist',
    });
  });

  it('unquotes a column name that contains a quote', () => {
    const mapped = convertError(
      dbError({
        code: '42703',
        severity: 'ERROR',
        message: 'column "od""d" does not exist',
        position: 8,
      }),
    );
    expect(mapped).toMatchObject({ kind: 'ColumnNotFound', column: 'od"d' });
  });

  it('maps a unique violation, preferring the constraint name', () => {
    const mapped = convertError(
      dbError({
        code: '23505',
        severity: 'ERROR',
        message:
          'duplicate key value violates unique constraint "User_email_key"',
        detail: 'Key (email)=(a@b.c) already exists.',
        table: 'User',
        constraint: 'User_email_key',
      }),
    );
    expect(mapped).toMatchObject({
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'User_email_key' },
      table: 'User',
    });
  });

  it('falls back to the key fields when there is no constraint name', () => {
    const mapped = convertError(
      dbError({
        code: '23505',
        severity: 'ERROR',
        message: 'duplicate key value violates unique constraint',
        detail: 'Key (a, b)=(1, 2) already exists.',
      }),
    );
    expect(mapped).toMatchObject({
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['a', 'b'] },
    });
  });

  it('recovers the table from a conventional constraint name', () => {
    const mapped = convertError(
      dbError({
        code: '23505',
        severity: 'ERROR',
        message:
          'duplicate key value violates unique constraint "Post_slug_key"',
        detail: 'Key (slug)=(x) already exists.',
        constraint: 'Post_slug_key',
      }),
    );
    expect(mapped).toMatchObject({ table: 'Post' });
  });

  it('maps a not-null violation', () => {
    const mapped = convertError(
      dbError({
        code: '23502',
        severity: 'ERROR',
        message: 'null value in column "score" violates not-null constraint',
        detail: 'Key (score)=(null) is not present.',
        column: 'score',
      }),
    );
    expect(mapped).toMatchObject({
      kind: 'NullConstraintViolation',
      constraint: { fields: ['score'] },
    });
  });

  it('maps a foreign key violation from the column', () => {
    const mapped = convertError(
      dbError({
        code: '23503',
        severity: 'ERROR',
        message:
          'insert or update on table "Book" violates foreign key constraint',
        column: 'authorId',
      }),
    );
    expect(mapped).toMatchObject({
      kind: 'ForeignKeyConstraintViolation',
      constraint: { fields: ['authorId'] },
    });
  });

  it('maps a restrict violation, which only exists from 7.10.0', () => {
    const mapped = convertError(
      dbError({
        code: '23001',
        severity: 'ERROR',
        message: 'update or delete violates RESTRICT setting',
        constraint: 'Book_authorId_fkey',
      }),
    );
    expect(mapped).toMatchObject({
      kind: 'RestrictViolation',
      constraint: { index: 'Book_authorId_fkey' },
    });
  });

  const simple: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      'a table that does not exist',
      {
        code: '42P01',
        message: 'relation "NoSuchTable" does not exist',
        position: 15,
      },
      { kind: 'TableDoesNotExist', table: 'NoSuchTable' },
    ],
    [
      'a value out of range',
      { code: '22003', message: 'numeric field overflow' },
      { kind: 'ValueOutOfRange', cause: 'numeric field overflow' },
    ],
    [
      'invalid input syntax',
      {
        code: '22P02',
        message: 'invalid input syntax for type integer: "zz"',
        position: 8,
      },
      {
        kind: 'InvalidInputValue',
        message: 'invalid input syntax for type integer: "zz"',
      },
    ],
    [
      'a length mismatch',
      { code: '22001', message: 'value too long', column: 'name' },
      { kind: 'LengthMismatch', column: 'name' },
    ],
    [
      'a serialization failure',
      { code: '40001', message: 'could not serialize access' },
      { kind: 'TransactionWriteConflict' },
    ],
    [
      'a deadlock',
      { code: '40P01', message: 'deadlock detected' },
      { kind: 'TransactionWriteConflict' },
    ],
    [
      'a database that does not exist',
      { code: '3D000', message: 'database "nope" does not exist' },
      { kind: 'DatabaseDoesNotExist', db: 'nope' },
    ],
    [
      'a database that already exists',
      { code: '42P04', message: 'database "dup" already exists' },
      { kind: 'DatabaseAlreadyExists', db: 'dup' },
    ],
    [
      'a failed password',
      {
        code: '28P01',
        message: 'password authentication failed for user "bob"',
      },
      { kind: 'AuthenticationFailed', user: 'bob' },
    ],
    [
      'too many connections',
      { code: '53300', message: 'too many clients already' },
      { kind: 'TooManyConnections', cause: 'too many clients already' },
    ],
    [
      'a connection PostgreJS synthesized a code for',
      { code: '08006', message: 'Connection terminated unexpectedly' },
      { kind: 'ConnectionClosed' },
    ],
  ];

  for (const [label, fields, expected] of simple) {
    it(`maps ${label}`, () => {
      expect(
        convertError(dbError({ severity: 'ERROR', ...fields })),
      ).toMatchObject(expected);
    });
  }

  it('hands anything it has no kind for to the generic postgres payload', () => {
    const mapped = convertError(
      dbError({
        code: '2BP01',
        severity: 'ERROR',
        message: 'cannot drop table because other objects depend on it',
        detail: 'view v depends on table t',
        hint: 'Use DROP ... CASCADE',
      }),
    );
    expect(mapped).toMatchObject({
      kind: 'postgres',
      code: '2BP01',
      severity: 'ERROR',
      message: 'cannot drop table because other objects depend on it',
      detail: 'view v depends on table t',
      hint: 'Use DROP ... CASCADE',
    });
  });

  describe('a connection that went away', () => {
    it('maps a clean close to ConnectionClosed', () => {
      expect(convertError(new ConnectionLostError(123))).toMatchObject({
        kind: 'ConnectionClosed',
      });
    });

    it('reads the socket error underneath when there is one', () => {
      const cause = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
        syscall: 'read',
        errno: -54,
      });
      expect(convertError(new ConnectionLostError(123, cause))).toMatchObject({
        kind: 'ConnectionClosed',
      });
    });

    it('reports an unreachable server with its address', () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
        syscall: 'connect',
        errno: -61,
        address: '127.0.0.1',
        port: 5432,
      });
      expect(
        convertError(new ConnectionLostError(undefined, cause)),
      ).toMatchObject({
        kind: 'DatabaseNotReachable',
        host: '127.0.0.1',
        port: 5432,
      });
    });
  });

  it('maps a bare socket error', () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND db'), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      errno: -3008,
      hostname: 'db',
    });
    expect(convertError(error)).toMatchObject({
      kind: 'DatabaseNotReachable',
      host: 'db',
    });
  });

  it('maps a socket timeout', () => {
    const error = Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT',
      syscall: 'connect',
      errno: -60,
    });
    expect(convertError(error)).toMatchObject({ kind: 'SocketTimeout' });
  });

  it('maps a TLS failure', () => {
    const error = Object.assign(new Error('self signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    expect(convertError(error)).toMatchObject({
      kind: 'TlsConnectionError',
      reason: 'self signed certificate',
    });
  });

  it('maps a server that refuses SSL', () => {
    expect(
      convertError(new Error('The server does not support SSL connections')),
    ).toMatchObject({ kind: 'TlsConnectionError' });
  });

  /**
   * The one thing this must not do is swallow a bug. A `TypeError` from the
   * adapter's own code dressed up as a database error would be invisible.
   */
  it('rethrows anything it does not recognise', () => {
    const bug = new TypeError('cannot read properties of undefined');
    expect(() => convertError(bug)).toThrow(bug);
  });
});
