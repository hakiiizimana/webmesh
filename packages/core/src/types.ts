// Re-export shim — all search domain types now live in ./search/types
// and the cross-domain ProviderKind lives in ./shared/provider-kind.
export type { Freshness, FreshnessRange, Provider } from "./search/types";
export type { ProviderKind } from "./shared/provider-kind";
export type { SearchContext, SearchFilters, SearchItem, SearchResult, SuccessfulSearch } from "./search/types";
export { searchItem, successfulSearch } from "./search/types";