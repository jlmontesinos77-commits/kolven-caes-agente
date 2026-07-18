// config.ts — lectura centralizada de variables de entorno (App Settings)
export function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && (!v || v.length === 0)) {
    throw new Error(`Falta App Setting requerido: ${name}`);
  }
  return v ?? "";
}

export interface TenantCfg {
  origen: "kolven" | "saas";
  supabaseUrl: string;
  supabaseKey: string;
}

// Resuelve la config de Supabase segun el origen del trabajo
export function tenantConfig(origen: string): TenantCfg {
  if (origen === "saas") {
    return {
      origen: "saas",
      supabaseUrl: env("SAAS_SUPABASE_URL"),
      supabaseKey: env("SAAS_SUPABASE_SECRET_KEY"),
    };
  }
  return {
    origen: "kolven",
    supabaseUrl: env("KOLVEN_SUPABASE_URL"),
    supabaseKey: env("KOLVEN_SUPABASE_SECRET_KEY"),
  };
}

export const CFG = {
  agenteSecret: () => env("AGENTE_SECRET"),
  anthropicKey: () => env("ANTHROPIC_API_KEY"),
  anthropicModel: () => env("ANTHROPIC_MODEL", false) || "claude-sonnet-4-6",
  docIntelEndpoint: () => env("DOCINTEL_ENDPOINT"),
  docIntelKey: () => env("DOCINTEL_KEY"),
  blobConn: () => env("CAES_BLOB_CONN"),
  blobContainer: () => env("CAES_BLOB_CONTAINER", false) || "caes-ingesta",
  graphTenant: () => env("GRAPH_TENANT_ID"),
  graphClient: () => env("GRAPH_CLIENT_ID"),
  graphSecret: () => env("GRAPH_CLIENT_SECRET"),
};
