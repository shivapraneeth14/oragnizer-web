class PaginatedList<T> {
  final List<T> items;
  final bool loading;
  final bool loadingMore;
  final bool hasMore;
  final String? error;

  const PaginatedList({
    this.items = const [],
    this.loading = false,
    this.loadingMore = false,
    this.hasMore = true,
    this.error,
  });

  PaginatedList<T> copyWith({
    List<T>? items,
    bool? loading,
    bool? loadingMore,
    bool? hasMore,
    String? error,
    bool clearError = false,
  }) {
    return PaginatedList(
      items: items ?? this.items,
      loading: loading ?? this.loading,
      loadingMore: loadingMore ?? this.loadingMore,
      hasMore: hasMore ?? this.hasMore,
      error: clearError ? null : error ?? this.error,
    );
  }
}
