// A preset row that publishes a service INSIDE an `isolate` realm, so the
// implementation lands under a realm-private symbol instead of the root realm.
// Declares `isolate: ['rsiScorer']` so the group row can key the realm on it.
export const name = 'isolated-service'
export const isolate = ['rsiScorer']

export function apply(ctx, config) {
  ctx.effect(() => ctx.reflect.provide('rsiScorer', { label: config.label }))
}
