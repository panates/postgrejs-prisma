import { expect } from 'expect';
import { Connection, isMultiStatement } from 'postgrejs';

/**
 * PostgreJS's scanner, checked against the only authority on the question.
 *
 * `executeRaw` routes on `isMultiStatement()`, so this adapter is only as good
 * as that answer - which is why the test stayed here after the util left. It
 * started in this package, was offered upstream because the question belongs
 * to anyone choosing between `query()` and `execute()` rather than to a Prisma
 * adapter, and landed in PostgreJS 3.11.0. This is the standing check that it
 * keeps answering what this adapter needs.
 *
 * The oracle is PostgreSQL. A statement sent on the extended protocol is
 * refused with `42601 cannot insert multiple commands into a prepared
 * statement` when and only when it holds more than one, so the server settles
 * every case rather than anyone's reading of the grammar.
 *
 * Which way a mismatch goes matters. Saying *several* about one statement
 * costs it its prepared plan and nothing else. Saying *one* about several is
 * what reaches a user, as a `42601` where `@prisma/adapter-pg` would have run
 * the script - so the corpus leans on the places a `;` can hide.
 */
describe('B-live: isMultiStatement() agrees with PostgreSQL', () => {
  let connection: Connection;

  before(async () => {
    connection = new Connection({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      // Off, so a refused statement is reported as itself rather than as the
      // savepoint machinery's view of it.
      rollbackOnError: false,
    });
    await connection.connect();
  });

  after(async () => {
    await connection?.close(0);
  });

  const corpus: string[] = [
    // string literals
    `select ';'`,
    `select 'a;b', 'c;d'`,
    `select 'it''s; fine'`,
    String.raw`select E'a\'; still one'`,
    `select '$$; not a dollar quote'`,
    `select '-- not a comment; really'`,
    `select '/* not a comment; */'`,
    `select '''; '''`,
    // quoted identifiers
    `select 1 as ";"`,
    `select 1 as "he""llo; x"`,
    // dollar quotes and function bodies
    `select $$ a; b $$`,
    `select $tag$ a; b $tag$`,
    `select $$;$$ || $$;$$`,
    `select $$ a '$$ || $$' b $$`,
    `do $$ begin perform 1; perform 2; end $$`,
    `create or replace function pg_temp.s1() returns int as $$ begin return 1; end; $$ language plpgsql`,
    `create or replace function pg_temp.s2() returns text as $body$ begin return 'a; b'; end; $body$ language plpgsql`,
    `create or replace function pg_temp.s3() returns text as $outer$ begin return $inner$ x; y $inner$; end; $outer$ language plpgsql`,
    // comments
    `select 1 -- ; trailing`,
    `select 1 /* ; */`,
    `select 1 /* a /* ; */ b */`,
    `/* lead; */ select 1`,
    // terminators, which are not second statements
    `select 1;`,
    `select 1;;`,
    `select 1; ;  `,
    `select 1; -- done`,
    `select 1; /* done */`,
    // genuinely several
    `select 1; select 2`,
    `select 'a;b'; select 2`,
    `do $$ begin perform 1; end $$; select 2`,
    `create or replace function pg_temp.s4() returns int as $$ begin return 1; end; $$ language plpgsql; select pg_temp.s4()`,
    `select 1; /* c */ select 2`,
    `select 1 -- c\n; select 2`,
    `select 'a' ; select 'b' ;`,
  ];

  /** What the server makes of it: refused for holding several, or not. */
  const serverSaysSeveral = async (sql: string): Promise<boolean> => {
    try {
      await connection.query(sql, { rowDecoder: 'array' });
      return false;
    } catch (e) {
      const error = e as { code?: string; serverMessage?: string };
      if (
        error.code === '42601' &&
        /multiple commands/i.test(error.serverMessage ?? '')
      ) {
        return true;
      }
      // Anything else means the statement is invalid for its own reasons, and
      // the server has told us nothing about how many statements it holds.
      // Every case above is valid SQL, so this is a broken test, not a result.
      throw new Error(
        `${JSON.stringify(sql)} did not run: ${error.code} ${error.serverMessage}`,
        { cause: e },
      );
    }
  };

  for (const sql of corpus) {
    it(`agrees on ${JSON.stringify(sql).slice(0, 62)}`, async () => {
      expect(isMultiStatement(sql)).toStrictEqual(await serverSaysSeveral(sql));
    });
  }
});
