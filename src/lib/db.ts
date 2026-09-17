import { createSupabase, createAuth, type MapKitConfig } from '@minormending/map-kit'

/**
 * Configuration, read once and passed explicitly into the kit.
 *
 * Astro evaluates modules twice — on the server during the build, and in the
 * browser as an island — and only `PUBLIC_`-prefixed variables survive into
 * the second. Reading them here in one place, rather than at module scope
 * inside the kit, is what keeps the two evaluations honest with each other.
 */
export const CONFIG: MapKitConfig = {
  supabaseUrl: import.meta.env.PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '',
}

/** Null when no project is configured — a supported state, not a failure.
 *  Phase 1 shipped with no database at all and the map worked. */
export const supabase = createSupabase(CONFIG)
export const auth = createAuth(supabase, CONFIG)

export const HAS_DB = supabase !== null
