import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../supabase_client.dart';
import '../models/models.dart';
import 'paginated_provider.dart';

const _pageSize = 20;

final communitiesProvider =
    StateNotifierProvider<CommunitiesNotifier, PaginatedList<Community>>((ref) {
  return CommunitiesNotifier();
});

class CommunitiesNotifier extends StateNotifier<PaginatedList<Community>> {
  int _page = 0;

  CommunitiesNotifier() : super(const PaginatedList(loading: true)) {
    fetchFirstPage();
  }

  Future<void> fetchFirstPage() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final res = await supabase
          .from('communities')
          .select('*')
          .isFilter('deleted_at', null)
          .order('created_at', ascending: false)
          .range(0, _pageSize - 1);
      _page = 0;
      final items = (res as List).cast<Map<String, dynamic>>().map((e) => Community.fromMap(e)).toList();
      state = PaginatedList(
        items: items,
        loading: false,
        hasMore: items.length >= _pageSize,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: e.toString());
    }
  }

  Future<void> fetchNextPage() async {
    if (state.loadingMore || !state.hasMore) return;
    state = state.copyWith(loadingMore: true);
    final from = (_page + 1) * _pageSize;
    final to = from + _pageSize - 1;
    try {
      final res = await supabase
          .from('communities')
          .select('*')
          .isFilter('deleted_at', null)
          .order('created_at', ascending: false)
          .range(from, to);
      _page++;
      final newItems = (res as List).cast<Map<String, dynamic>>().map((e) => Community.fromMap(e)).toList();
      state = PaginatedList(
        items: [...state.items, ...newItems],
        loading: false,
        loadingMore: false,
        hasMore: newItems.length >= _pageSize,
      );
    } catch (e) {
      state = state.copyWith(loadingMore: false, error: e.toString());
    }
  }

  Future<void> refresh() async {
    _page = 0;
    await fetchFirstPage();
  }
}

final myCommunitiesProvider = FutureProvider<List<Community>>((ref) async {
  final session = supabase.auth.currentSession;
  if (session == null) return [];
  final response = await supabase
      .from('community_members')
      .select('role, communities(*)')
      .eq('user_id', session.user.id)
      .order('joined_at', ascending: false);
  return (response as List).map((row) {
    final m = row as Map<String, dynamic>;
    final comm = m['communities'] as Map<String, dynamic>?;
    return Community.fromMap(comm ?? {});
  }).toList();
});
