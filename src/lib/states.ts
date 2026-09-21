/**
 * The states a submitted farm can be in.
 *
 * `AddOrchard` sent a hardcoded 'NY' with every submission, because the form
 * had no state field and the column had to be given something. That was right
 * for the bulk of the map and silently wrong for the rest: a Connecticut farm
 * arrived claiming to be in New York, and nothing downstream had any way to
 * notice — a wrong state reads exactly like a right one.
 *
 * Written out rather than derived from `ORCHARDS`. Deriving it looks tempting
 * and is circular: a state with no listings yet would be the one state nobody
 * could submit, and the first farm somewhere new is the one most worth
 * hearing about. `test/data.test.mjs` checks the other direction instead —
 * every state the data already contains has to appear here — which is what
 * catches a list that has fallen behind the map.
 *
 * Ordered by how much of the map each one is, so the common answer is the
 * first one somebody reads. Massachusetts is last and belongs here: four
 * listings already carry 'MA', and a list without it could not describe a farm
 * the map is already showing.
 */
export interface StateOption {
  /** As the `state` column stores it: two letters, upper case. */
  code: string
  name: string
}

export const STATES: StateOption[] = [
  { code: 'NY', name: 'New York' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'MA', name: 'Massachusetts' },
]
