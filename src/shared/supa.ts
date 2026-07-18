// supa.ts — cliente Supabase minimo (REST + RPC) con service key
import { fetchConTimeout } from "./neto";
import { TenantCfg } from "./config";

export class Supa {
  constructor(private cfg: TenantCfg) {}

  private headers() {
    return {
      apikey: this.cfg.supabaseKey,
      Authorization: `Bearer ${this.cfg.supabaseKey}`,
      "Content-Type": "application/json",
    };
  }

  // Llama a una RPC de Postgres
  async rpc<T = any>(fn: string, args: Record<string, any>): Promise<T> {
    const url = `${this.cfg.supabaseUrl}/rest/v1/rpc/${fn}`;
    const r = await fetchConTimeout(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(args),
    }, 30000);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`RPC ${fn} fallo ${r.status}: ${t}`);
    }
    return (await r.json()) as T;
  }

  // SELECT simple con filtros PostgREST
  async select<T = any>(table: string, query: string): Promise<T[]> {
    const url = `${this.cfg.supabaseUrl}/rest/v1/${table}?${query}`;
    const r = await fetchConTimeout(url, { headers: this.headers() }, 30000);
    if (!r.ok) throw new Error(`SELECT ${table} fallo ${r.status}: ${await r.text()}`);
    return (await r.json()) as T[];
  }

  // INSERT devolviendo la fila
  async insert<T = any>(table: string, row: Record<string, any>): Promise<T> {
    const url = `${this.cfg.supabaseUrl}/rest/v1/${table}`;
    const r = await fetchConTimeout(url, {
      method: "POST",
      headers: { ...this.headers(), Prefer: "return=representation" },
      body: JSON.stringify(row),
    }, 30000);
    if (!r.ok) throw new Error(`INSERT ${table} fallo ${r.status}: ${await r.text()}`);
    const arr = (await r.json()) as T[];
    return arr[0];
  }

  // UPDATE con filtro
  async update(table: string, query: string, patch: Record<string, any>): Promise<void> {
    const url = `${this.cfg.supabaseUrl}/rest/v1/${table}?${query}`;
    const r = await fetchConTimeout(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(patch),
    }, 30000);
    if (!r.ok) throw new Error(`UPDATE ${table} fallo ${r.status}: ${await r.text()}`);
  }
}
