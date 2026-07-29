import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../providers/community_provider.dart';
import '../providers/paginated_provider.dart';
import '../widgets/notification_bell.dart';
import '../models/models.dart';

class CommunitiesScreen extends ConsumerStatefulWidget {
  const CommunitiesScreen({super.key});

  @override
  ConsumerState<CommunitiesScreen> createState() => _CommunitiesScreenState();
}

class _CommunitiesScreenState extends ConsumerState<CommunitiesScreen> {
  final _searchController = TextEditingController();
  final _scrollController = ScrollController();
  Timer? _debounce;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _searchController.dispose();
    _scrollController.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollController.position.pixels < _scrollController.position.maxScrollExtent - 200) return;
    ref.read(communitiesProvider.notifier).fetchNextPage();
  }

  List<Community> _filter(List<Community> data) {
    if (_query.isEmpty) return data;
    final q = _query.toLowerCase();
    return data.where((c) {
      return c.name.toLowerCase().contains(q)
          || (c.description ?? '').toLowerCase().contains(q)
          || (c.city ?? '').toLowerCase().contains(q)
          || (c.country ?? '').toLowerCase().contains(q)
          || (c.category ?? '').toLowerCase().contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(communitiesProvider);

    return Scaffold(
      appBar: AppBar(
        centerTitle: true,
        title: Text(
          'CLUVO',
          style: TextStyle(
            fontWeight: FontWeight.bold,
            letterSpacing: 2,
            color: const Color(0xFFC2185B),
          ),
        ),
        actions: [const NotificationBell()],
      ),
      body: state.loading
          ? _buildSkeleton()
          : state.error != null && state.items.isEmpty
              ? _buildError(state.error!)
              : _buildContent(state),
    );
  }

  Widget _buildContent(PaginatedList<Community> state) {
    final filtered = _filter(state.items);
    final notifier = ref.read(communitiesProvider.notifier);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: TextField(
            controller: _searchController,
            onChanged: (v) {
              _debounce?.cancel();
              _debounce = Timer(const Duration(milliseconds: 300), () {
                setState(() => _query = v.trim());
              });
            },
            decoration: InputDecoration(
              hintText: 'Search communities...',
              prefixIcon: const Icon(Icons.search, size: 20),
              suffixIcon: _searchController.text.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.clear, size: 18),
                      onPressed: () {
                        _searchController.clear();
                        setState(() => _query = '');
                      },
                    )
                  : null,
              filled: true,
              fillColor: Colors.grey[100],
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none,
              ),
              contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 12),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: notifier.refresh,
            child: filtered.isEmpty
                ? ListView(
                    children: [
                      const SizedBox(height: 200),
                      Center(
                        child: Text(
                          _query.isEmpty ? 'No communities yet.' : 'No communities match "$_query".',
                          style: const TextStyle(color: Colors.grey),
                        ),
                      ),
                    ],
                  )
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(16),
                    itemCount: filtered.length + (state.hasMore ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index == filtered.length) {
                        return const Padding(
                          padding: EdgeInsets.symmetric(vertical: 20),
                          child: Center(
                            child: SizedBox(
                              width: 20, height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                        );
                      }
                      final c = filtered[index];
                      final bannerUrl = c.bannerUrl;
                      final name = c.name;

                      return RepaintBoundary(
                        child: Card(
                          margin: const EdgeInsets.only(bottom: 16),
                          clipBehavior: Clip.antiAlias,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: InkWell(
                            onTap: () => context.push('/communities/${c.id}'),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                AspectRatio(
                                  aspectRatio: 16 / 9,
                                  child: bannerUrl != null && bannerUrl.isNotEmpty
                                      ? CachedNetworkImage(
                                          imageUrl: bannerUrl,
                                          fit: BoxFit.cover,
                                          width: double.infinity,
                                          errorWidget: (_, __, ___) =>
                                              _buildBannerFallback(name),
                                        )
                                      : _buildBannerFallback(name),
                                ),
                                Padding(
                                  padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        name,
                                        style: const TextStyle(
                                          fontSize: 16,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                      const SizedBox(height: 4),
                                      Row(
                                        children: [
                                          if (c.category != null) ...[
                                            Container(
                                              padding: const EdgeInsets.symmetric(
                                                  horizontal: 8, vertical: 2),
                                              decoration: BoxDecoration(
                                                color: const Color(0xFFC2185B)
                                                    .withValues(alpha: 0.1),
                                                borderRadius:
                                                    BorderRadius.circular(12),
                                              ),
                                              child: Text(
                                                c.category!,
                                                style: const TextStyle(
                                                  fontSize: 11,
                                                  color: Color(0xFFC2185B),
                                                ),
                                              ),
                                            ),
                                            const SizedBox(width: 8),
                                          ],
                                          Icon(Icons.people,
                                              size: 14, color: Colors.grey[500]),
                                          const SizedBox(width: 3),
                                          Text(
                                            '${c.memberCount}',
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: Colors.grey[600],
                                            ),
                                          ),
                                          if (c.country != null) ...[
                                            const Spacer(),
                                            Icon(Icons.location_on,
                                                size: 14, color: Colors.grey[400]),
                                            const SizedBox(width: 2),
                                            Text(
                                              '${c.city ?? ''}${c.city != null ? ', ' : ''}${c.country ?? ''}',
                                              style: TextStyle(
                                                fontSize: 11,
                                                color: Colors.grey[500],
                                              ),
                                            ),
                                          ],
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }

  Widget _buildError(String errorMsg) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 40, color: Colors.grey),
            const SizedBox(height: 12),
            Text('Could not load communities.\n$errorMsg',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey[600])),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: () => ref.read(communitiesProvider.notifier).refresh(),
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Tap to Retry'),
              style: OutlinedButton.styleFrom(
                foregroundColor: const Color(0xFFC2185B),
                side: const BorderSide(color: Color(0xFFC2185B)),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSkeleton() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: List.generate(3, (_) => _buildSkeletonCard()),
    );
  }

  Widget _buildSkeletonCard() {
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Column(
        children: [
          AspectRatio(
            aspectRatio: 16 / 9,
            child: Container(color: Colors.grey[200]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(height: 14, width: 180, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
                const SizedBox(height: 8),
                Container(height: 12, width: 240, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBannerFallback(String name) {
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [Color(0xFFC2185B), Color(0xFFE0407A)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Center(
        child: Text(
          name.isNotEmpty ? name[0].toUpperCase() : 'C',
          style: const TextStyle(
            color: Colors.white,
            fontSize: 48,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
    );
  }
}
