import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./schema"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Hash } from "@/util/hash"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name?: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export const Path = iife(() => {
    const channel = Installation.CHANNEL
    if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "opencode.db")
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(Global.Path.data, `opencode-${safe}.db`)
  })

  type Schema = typeof schema
  export type Transaction = SQLiteTransaction<"sync", void, Schema>

  type Client = SQLiteBunDatabase

  type Journal = { sql: string; timestamp: number; name: string }[]

  function normalize(entries: { sql: string; timestamp: number; name?: string }[]): Journal {
    let missing = 0
    const result = entries.map((entry, i) => {
      if (entry.name) return { sql: entry.sql, timestamp: entry.timestamp, name: entry.name }
      missing++
      return {
        sql: entry.sql,
        timestamp: entry.timestamp,
        name: `${entry.timestamp}-${i}`,
      }
    })
    if (missing > 0) {
      log.warn("migration entries missing names", { missing })
    }
    return result
  }

  const state = {
    sqlite: undefined as BunDatabase | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  function table(sqlite: BunDatabase, name: string) {
    return !!sqlite.query("select 1 from sqlite_master where type = 'table' and name = ? limit 1").get(name as never)
  }

  function column(sqlite: BunDatabase, name: string, key: string) {
    if (!table(sqlite, name)) return false
    const rows = sqlite.query(`pragma table_info(${name})`).all() as { name?: string }[]
    return rows.some((row) => row.name === key)
  }

  function repairLegacyAccount(sqlite: BunDatabase) {
    const control = table(sqlite, "control_account")
    const account = table(sqlite, "account")
    const state = table(sqlite, "account_state")
    let fixed = false

    if (!account && control) {
      log.warn("repairing legacy account table")
      sqlite.run(`
        CREATE TABLE IF NOT EXISTS account (
          id text PRIMARY KEY,
          email text NOT NULL,
          url text NOT NULL,
          access_token text NOT NULL,
          refresh_token text NOT NULL,
          token_expiry integer,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        )
      `)
      const rows = sqlite
        .query(
          "select email, url, access_token, refresh_token, token_expiry, active, time_created, time_updated from control_account",
        )
        .all() as {
        email: string
        url: string
        access_token: string
        refresh_token: string
        token_expiry: number | null
        active: number
        time_created: number
        time_updated: number
      }[]
      let activeID: string | undefined
      for (const row of rows) {
        const id = Hash.fast(`${row.url}\0${row.email}`)
        sqlite
          .query(
            `insert into account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set
               email = excluded.email,
               url = excluded.url,
               access_token = excluded.access_token,
               refresh_token = excluded.refresh_token,
               token_expiry = excluded.token_expiry,
               time_updated = excluded.time_updated`,
          )
          .run(
            id,
            row.email,
            row.url,
            row.access_token,
            row.refresh_token,
            row.token_expiry,
            row.time_created,
            row.time_updated,
          )
        if (row.active) activeID = id
      }
      if (activeID) {
        sqlite.run(`
          CREATE TABLE IF NOT EXISTS account_state (
            id integer PRIMARY KEY NOT NULL,
            active_account_id text references account(id) on delete set null,
            active_org_id text
          )
        `)
        sqlite
          .query(
            `insert into account_state (id, active_account_id, active_org_id)
             values (1, ?, null)
             on conflict(id) do update set active_account_id = excluded.active_account_id, active_org_id = excluded.active_org_id`,
          )
          .run(activeID)
      }
      fixed = true
    }

    if (!state && (control || table(sqlite, "account"))) {
      log.warn("repairing legacy account state table")
      sqlite.run(`
        CREATE TABLE IF NOT EXISTS account_state (
          id integer PRIMARY KEY NOT NULL,
          active_account_id text references account(id) on delete set null,
          active_org_id text
        )
      `)
      const active = control
        ? (sqlite
            .query("select url, email from control_account where active = 1 order by time_updated desc limit 1")
            .get() as { url: string; email: string } | null)
        : null
      if (active) {
        const id = Hash.fast(`${active.url}\0${active.email}`)
        sqlite
          .query(
            `insert into account_state (id, active_account_id, active_org_id)
             values (1, ?, null)
             on conflict(id) do update set active_account_id = excluded.active_account_id`,
          )
          .run(id)
      }
      fixed = true
    }

    if (table(sqlite, "account_state") && !column(sqlite, "account_state", "active_org_id")) {
      log.warn("repairing missing active_org_id column")
      sqlite.run("alter table account_state add active_org_id text")
      fixed = true
    }

    if (
      table(sqlite, "account") &&
      column(sqlite, "account", "selected_org_id") &&
      column(sqlite, "account_state", "active_org_id")
    ) {
      sqlite.run(`
        update account_state
        set active_org_id = (
          select selected_org_id from account where account.id = account_state.active_account_id
        )
        where active_account_id is not null and active_org_id is null
      `)
      fixed = true
    }

    return fixed
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: Path })

    const sqlite = new BunDatabase(Path, { create: true })
    state.sqlite = sqlite

    sqlite.run("PRAGMA journal_mode = WAL")
    sqlite.run("PRAGMA synchronous = NORMAL")
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA cache_size = -64000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")

    const db = drizzle({ client: sqlite })

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? normalize(OPENCODE_MIGRATIONS)
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      const repaired = repairLegacyAccount(sqlite)
      if (repaired) {
        const move = entries.find((item) => item.name === "20260309230000_move_org_to_state")
        if (move) move.sql = "select 1;"
      }
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrate(db, entries)
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Client.reset()
  }

  export type TxOrDb = SQLiteTransaction<"sync", void, any, any> | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export function transaction<T>(callback: (tx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = (Client().transaction as any)((tx: TxOrDb) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        })
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
