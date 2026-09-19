/**
 * Where a listing came from, and under what terms.
 *
 * Every row carries `import_source` and `import_licence`, and the About page
 * makes a promise about them: "Every listing records where it came from and
 * under what terms, so withdrawing a source is one filter rather than an
 * archaeology project."
 *
 * The orchard pages did not keep that promise. The "Listed by" row was a
 * hardcoded string, so all 251 pages credited the New York Apple Association —
 * including 39 farms from Connecticut, 14 from Pennsylvania, and 10 rows from
 * OpenStreetMap, whose ODbL licence requires attribution as a condition of
 * use. Getting that wrong is not a typo; it is the one thing on the page a
 * source could reasonably object to.
 *
 * So the names live here, once, and both the pages and the About list read
 * them. A source the data contains but this file does not is rendered as the
 * raw key rather than silently attributed to somebody else — wrong, but
 * visibly wrong, and never wrong about a different organisation.
 */
export interface Source {
  /** The value in `import_source`. */
  key: string
  /** Who to credit, in their own name. */
  name: string
  /** The terms, as published. */
  licence: string
  /** Where the licence can be read, when there is one to read. */
  licenceUrl?: string
  /** Why the terms read as they do, for the About page. */
  note?: string
}

export const SOURCES: Source[] = [
  {
    key: 'nyaa',
    name: 'New York Apple Association',
    licence: 'no licence stated',
    note:
      'That is ambiguity rather than permission, and it is recorded as ' +
      'unstated rather than left blank or guessed at.',
  },
  {
    key: 'ctapples',
    name: 'Connecticut Apple Marketing Board',
    licence: 'no licence stated',
  },
  {
    key: 'papreferred',
    name: 'PA Preferred',
    licence: 'no licence stated',
  },
  {
    key: 'osm',
    name: 'OpenStreetMap contributors',
    licence: 'ODbL 1.0',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/',
    note:
      'Requires attribution and share-alike. The only rows here whose terms ' +
      'are not a guess.',
  },
]

export const SOURCE_BY_KEY = new Map(SOURCES.map((s) => [s.key, s]))

/** What to call a field in a credit line. */
const FIELD_NAMES: Record<string, string> = {
  name: 'its name',
  geog: 'its position',
  address: 'the address',
  town: 'the town',
  state: 'the state',
  zip: 'the postcode',
  phone: 'the phone number',
  website: 'the website',
  tags: 'what it does',
}

/**
 * The fields on this farm that came from somewhere other than its own source,
 * grouped by who supplied them.
 *
 * Returns an empty array for almost every farm. A row here means the page must
 * not credit one source for work another did — which is exactly what happened
 * before this existed: an OpenStreetMap row was crediting OSM for an address
 * the Connecticut board supplied.
 */
export function fieldCredits(orchard: {
  import_source: string
  field_sources?: Record<string, string>
}): { name: string; fields: string[] }[] {
  const bySource = new Map<string, string[]>()
  for (const [field, source] of Object.entries(orchard.field_sources ?? {})) {
    if (source === orchard.import_source) continue
    const label = FIELD_NAMES[field] ?? field
    bySource.set(source, [...(bySource.get(source) ?? []), label])
  }
  return [...bySource].map(([key, fields]) => ({
    name: SOURCE_BY_KEY.get(key)?.name ?? key,
    // Stable order, so the sentence does not reshuffle between builds.
    fields: fields.sort(),
  }))
}

/**
 * The credit line for one row.
 *
 * Prefers the row's own `import_licence` over the source's, because the two
 * can legitimately differ — a source that publishes terms later should not
 * retroactively relabel rows imported before it did.
 */
export function creditFor(orchard: { import_source: string; import_licence: string }) {
  const source = SOURCE_BY_KEY.get(orchard.import_source)
  const licence = orchard.import_licence === 'unstated'
    ? 'no licence stated'
    : orchard.import_licence
  return {
    name: source?.name ?? orchard.import_source,
    licence,
    licenceUrl: source?.licenceUrl,
    known: source !== undefined,
  }
}
