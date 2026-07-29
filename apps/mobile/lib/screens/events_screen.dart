import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../providers/event_provider.dart';
import '../providers/paginated_provider.dart';
import '../models/models.dart';
import '../widgets/notification_bell.dart';

const _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

String _categorize(Event event, DateTime today) {
  final eventDay = DateTime(event.startDate.year, event.startDate.month, event.startDate.day);
  if (eventDay.isBefore(today)) return 'past';
  if (eventDay.isAtSameMomentAs(today)) return 'today';
  return 'upcoming';
}

class EventsScreen extends ConsumerStatefulWidget {
  const EventsScreen({super.key});

  @override
  ConsumerState<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends ConsumerState<EventsScreen> {
  String? _filter;
  DateTime? _pickedDate;
  final _searchController = TextEditingController();
  final _scrollController = ScrollController();
  Timer? _debounce;
  String _searchQuery = '';

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
    ref.read(eventsProvider.notifier).fetchNextPage();
  }

  List<Event> _applyFilter(List<Event> events) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);

    var result = events;

    if (_searchQuery.isNotEmpty) {
      final q = _searchQuery.toLowerCase();
      result = result.where((e) {
        final communityName = e.communityName ?? '';
        return e.title.toLowerCase().contains(q)
            || communityName.toLowerCase().contains(q)
            || (e.description ?? '').toLowerCase().contains(q)
            || (e.location ?? '').toLowerCase().contains(q);
      }).toList();
    }

    if (_pickedDate != null) {
      final pickDay = DateTime(_pickedDate!.year, _pickedDate!.month, _pickedDate!.day);
      return result.where((e) {
        return DateTime(e.startDate.year, e.startDate.month, e.startDate.day).isAtSameMomentAs(pickDay);
      }).toList();
    }

    return result.where((e) {
      final cat = _categorize(e, today);
      if (_filter == null) return true;
      return cat == _filter;
    }).toList();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _pickedDate ?? now,
      firstDate: now.subtract(const Duration(days: 365)),
      lastDate: now.add(const Duration(days: 365)),
    );
    if (picked != null) {
      setState(() {
        _pickedDate = picked;
        _filter = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(eventsProvider);

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

  Widget _buildContent(PaginatedList<Event> state) {
    final filtered = _applyFilter(state.items);
    final notifier = ref.read(eventsProvider.notifier);

    return RefreshIndicator(
      onRefresh: notifier.refresh,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: TextField(
              controller: _searchController,
              onChanged: (v) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 300), () {
                  setState(() => _searchQuery = v.trim());
                });
              },
              decoration: InputDecoration(
                hintText: 'Search events...',
                prefixIcon: const Icon(Icons.search, size: 20),
                suffixIcon: _searchController.text.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear, size: 18),
                        onPressed: () {
                          _searchController.clear();
                          setState(() => _searchQuery = '');
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
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: SizedBox(
              height: 36,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  _buildChip('All', null),
                  const SizedBox(width: 6),
                  _buildChip('Today', 'today'),
                  const SizedBox(width: 6),
                  _buildChip('Upcoming', 'upcoming'),
                  const SizedBox(width: 6),
                  _buildDateChip(),
                ],
              ),
            ),
          ),
          Expanded(
            child: filtered.isEmpty
                ? ListView(
                    children: [
                      const SizedBox(height: 200),
                      Center(
                        child: Text(
                          _pickedDate != null
                              ? 'No events on this date.'
                              : _searchQuery.isNotEmpty
                                  ? 'No events match \"$_searchQuery\".'
                                  : 'No upcoming events.',
                          style: const TextStyle(color: Colors.grey),
                        ),
                      ),
                    ],
                  )
                : GridView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(12),
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 3,
                      mainAxisSpacing: 10,
                      crossAxisSpacing: 10,
                      childAspectRatio: 0.85,
                    ),
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
                      final e = filtered[index];
                      final communityName = e.communityName;
                      final imageUrl = e.imageUrl;
                      final price = e.price;
                      final title = e.title;

                      return RepaintBoundary(
                        child: Card(
                          clipBehavior: Clip.antiAlias,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: InkWell(
                            onTap: () => context.push('/events/${e.id}'),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(
                                  flex: 2,
                                  child: imageUrl != null && imageUrl.isNotEmpty
                                      ? CachedNetworkImage(
                                          imageUrl: imageUrl,
                                          fit: BoxFit.cover,
                                          width: double.infinity,
                                          placeholder: (_, __) => const SizedBox(),
                                          errorWidget: (_, __, ___) =>
                                              _buildImageFallback(title),
                                        )
                                      : _buildImageFallback(title),
                                ),
                                Expanded(
                                  flex: 2,
                                  child: Padding(
                                    padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          title,
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            fontSize: 11,
                                            fontWeight: FontWeight.w600,
                                            height: 1.2,
                                          ),
                                        ),
                                        const SizedBox(height: 2),
                                        if (communityName != null)
                                          Text(
                                            communityName,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              fontSize: 9,
                                              color: Colors.grey[500],
                                            ),
                                          ),
                                        const Spacer(),
                                        Row(
                                          children: [
                                            Text(
                                              _formatShortDate(e),
                                              style: TextStyle(
                                                fontSize: 8,
                                                color: Colors.grey[400],
                                              ),
                                            ),
                                            const Spacer(),
                                            Text(
                                              price > 0
                                                  ? '₹${(price / 100).toStringAsFixed(0)}'
                                                  : 'Free',
                                              style: TextStyle(
                                                fontSize: 10,
                                                fontWeight: FontWeight.w600,
                                                color: price > 0
                                                    ? const Color(0xFFC2185B)
                                                    : Colors.green,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ),
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
        ],
      ),
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
            Text('Could not load events.\n$errorMsg',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey[600])),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: () => ref.read(eventsProvider.notifier).refresh(),
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

  Widget _buildChip(String label, String? category) {
    final selected = _filter == category && _pickedDate == null;
    return GestureDetector(
      onTap: () => setState(() {
        _filter = selected ? null : category;
        _pickedDate = null;
      }),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? const Color(0xFFC2185B) : Colors.grey[100],
          borderRadius: BorderRadius.circular(20),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: selected ? Colors.white : Colors.grey[700],
          ),
        ),
      ),
    );
  }

  Widget _buildDateChip() {
    final selected = _pickedDate != null;
    return GestureDetector(
      onTap: _pickDate,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? const Color(0xFFC2185B) : Colors.grey[100],
          borderRadius: BorderRadius.circular(20),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.calendar_today,
              size: 13,
              color: selected ? Colors.white : Colors.grey[600],
            ),
            const SizedBox(width: 4),
            Text(
              selected
                  ? '${_pickedDate!.day}/${_pickedDate!.month}'
                  : 'Pick Date',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: selected ? Colors.white : Colors.grey[700],
              ),
            ),
            if (selected) ...[
              const SizedBox(width: 4),
              GestureDetector(
                onTap: () => setState(() => _pickedDate = null),
                child: Icon(Icons.close, size: 14, color: Colors.white),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildSkeleton() {
    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: 0.85,
      ),
      itemCount: 6,
      physics: const NeverScrollableScrollPhysics(),
      itemBuilder: (_, __) => Card(
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        child: Column(
          children: [
            Expanded(
              flex: 2,
              child: Container(color: Colors.grey[200]),
            ),
            Expanded(
              flex: 2,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(height: 8, width: 70, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
                    const SizedBox(height: 6),
                    Container(height: 6, width: 50, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
                    const Spacer(),
                    Container(height: 8, width: 30, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildImageFallback(String title) {
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
          title.isNotEmpty ? title[0].toUpperCase() : 'E',
          style: const TextStyle(
            color: Colors.white,
            fontSize: 24,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
    );
  }

  String _formatShortDate(Event event) {
    return '${event.startDate.day} ${_months[event.startDate.month - 1]}';
  }
}
