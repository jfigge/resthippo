/**
 * graphql-entry.js — graphql-js bundle entry point
 *
 * Re-exports the minimal slice of graphql-js needed to fully validate a query
 * in the editor:
 *   - parse              syntax check (throws GraphQLError on malformed input)
 *   - print              format a parsed query AST back to canonical text
 *   - validate           schema validation of a parsed document
 *   - buildClientSchema  turn an introspection result into a GraphQLSchema
 *   - printSchema        render a GraphQLSchema back to SDL (view / download)
 *   - GraphQLError       so callers can type-check / read .locations
 *
 * esbuild tree-shakes the rest of graphql-js away, so the bundle stays small.
 *
 * This file is NOT imported at runtime — it is compiled by esbuild into
 *   web/scripts/vendor/graphql.js
 * via the `vendor-graphql` npm / make target.
 */

export {
  parse,
  print,
  validate,
  buildClientSchema,
  printSchema,
  GraphQLError,
} from "graphql";
