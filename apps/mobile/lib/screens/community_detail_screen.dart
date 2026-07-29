import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../config.dart';
import '../supabase_client.dart';
import '../widgets/media_gallery.dart';
import '../models/models.dart';

const _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

class CommunityDetailScreen extends StatefulWidget {
  final String id;
  const CommunityDetailScreen({super.key, required this.id});

  @override
  State<CommunityDetailScreen> createState() => _CommunityDetailScreenState();
}

class _CommunityDetailScreenState extends State<CommunityDetailScreen> {
  Map<String, dynamic>? _community;
  List<Event> _events = [];
  List<Map<String, dynamic>> _media = [];
  bool _loading = true;
  String? _error;
  bool _isMember = false;
  bool _isOwner = false;
  bool _followToggling = false;
  String? _eventFilter;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final session = supabase.auth.currentSession;
      final communityFuture = supabase
          .from('communities')
          .select('*')
          .eq('id', widget.id)
          .single();
      final eventsFuture = supabase
          .from('events')
          .select('*')
          .eq('community_id', widget.id)
          .isFilter('deleted_at', null)
          .order('start_date', ascending: false)
          .limit(50);

      bool isMember = false;
      bool isOwner = false;

      final mediaFuture = supabase
          .from('media')
          .select('*')
          .eq('mediable_type', 'community')
          .eq('mediable_id', widget.id)
          .order('sort_order');

      if (session != null) {
        final results = await Future.wait([
          communityFuture,
          eventsFuture,
          mediaFuture,
          supabase
              .from('community_members')
              .select('role')
              .eq('community_id', widget.id)
              .eq('user_id', session.user.id)
              .maybeSingle(),
        ]);
        if (!mounted) return;
        final memberRes = results[3];
        if (memberRes != null) {
          isMember = true;
          isOwner = (memberRes as Map<String, dynamic>)['role'] == 'OWNER';
        }
        final events = (results[1] as List).map((e) => Event.fromMap(e as Map<String, dynamic>)).toList();
        setState(() {
          _community = results[0] as Map<String, dynamic>?;
          _events = events;
          _media = (results[2] as List).cast<Map<String, dynamic>>();
          _isMember = isMember;
          _isOwner = isOwner;
          _loading = false;
        });
      } else {
        final results = await Future.wait([
          communityFuture,
          eventsFuture,
          mediaFuture,
        ]);
        if (!mounted) return;
        final events = (results[1] as List).map((e) => Event.fromMap(e as Map<String, dynamic>)).toList();
        setState(() {
          _community = results[0] as Map<String, dynamic>?;
          _events = events;
          _media = (results[2] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _toggleFollow() async {
    if (_followToggling) return;
    final session = supabase.auth.currentSession;
    if (session == null) return;
    setState(() => _followToggling = true);

    try {
      if (_isMember) {
        await supabase
            .from('community_members')
            .delete()
            .eq('community_id', widget.id)
            .eq('user_id', session.user.id);
        if (!mounted) return;
        setState(() {
          _isMember = false;
          _community!['member_count'] = ((_community!['member_count'] as num?) ?? 1) - 1;
        });
      } else {
        await supabase.from('community_members').insert({
          'community_id': widget.id,
          'user_id': session.user.id,
          'role': 'MEMBER',
        });
        if (!mounted) return;
        setState(() {
          _isMember = true;
          _community!['member_count'] = ((_community!['member_count'] as num?) ?? 0) + 1;
        });
      }
    } catch (_) {}

    if (mounted) setState(() => _followToggling = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Scaffold(
        body: _buildSkeleton(),
      );
    }

    if (_error != null || _community == null) {
      return Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_back),
            onPressed: () => context.pop(),
          ),
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, size: 40, color: Colors.grey),
                const SizedBox(height: 12),
                Text(_error != null ? 'Error: $_error' : 'Not found',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey[600])),
                const SizedBox(height: 16),
                OutlinedButton.icon(
                  onPressed: () {
                    _loading = true;
                    _load();
                  },
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
        ),
      );
    }

    final c = _community!;
    final bannerUrl = c['banner_url'] as String?;
    final name = c['name'] as String;
    final session = supabase.auth.currentSession;

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async {
          _loading = true;
          await _load();
        },
        child: CustomScrollView(
        slivers: [
          SliverAppBar(
            expandedHeight: 220,
            pinned: false,
            stretch: true,
            backgroundColor: const Color(0xFFC2185B),
            leading: Container(
              margin: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.3),
                shape: BoxShape.circle,
              ),
              child: IconButton(
                icon: const Icon(Icons.arrow_back, color: Colors.white),
                onPressed: () => context.pop(),
              ),
            ),
            flexibleSpace: FlexibleSpaceBar(
              background: bannerUrl != null && bannerUrl.isNotEmpty
                  ? CachedNetworkImage(
                      imageUrl: bannerUrl,
                      fit: BoxFit.cover,
                      width: double.infinity,
                      errorWidget: (_, __, ___) => _buildBannerFallback(name),
                    )
                  : _buildBannerFallback(name),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Text(
                          name,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                      if (session != null && !_isOwner)
                        _buildFollowButton(),
                      _buildShareButton(),
                    ],
                  ),
                  if (c['description'] != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      c['description'] as String,
                      style:
                          TextStyle(color: Colors.grey[600], fontSize: 14),
                    ),
                  ],
                  const SizedBox(height: 16),
                  _infoRow('Category', c['category'] as String? ?? '—'),
                  _infoRow(
                      'Members', '${c['member_count'] ?? 0}'),
                  _infoRow(
                      'Location',
                      '${c['city'] ?? ''}${c['city'] != null && c['country'] != null ? ', ' : ''}${c['country'] ?? '—'}'),
                  if (c['contact_email'] != null)
                    _infoRow('Contact', c['contact_email'] as String),
                  if (c['tags'] != null &&
                      (c['tags'] as List).isNotEmpty) ...[
                    const SizedBox(height: 12),
                    const Text('Tags',
                        style: TextStyle(
                            fontWeight: FontWeight.w500, fontSize: 13)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: (c['tags'] as List).map((t) => Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: Colors.grey[100],
                              borderRadius: BorderRadius.circular(16),
                            ),
                            child: Text(t.toString(),
                                style: const TextStyle(fontSize: 12)),
                          )).toList(),
                    ),
                  ],
                  if (c['rules'] != null &&
                      (c['rules'] as String).isNotEmpty) ...[
                    const SizedBox(height: 16),
                    const Divider(),
                    const SizedBox(height: 8),
                    const Text('Rules',
                        style: TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 14)),
                    const SizedBox(height: 4),
                    Text(c['rules'] as String,
                        style:
                            TextStyle(color: Colors.grey[600], fontSize: 13)),
                  ],
                  const SizedBox(height: 16),
                  MediaGallery(
                    media: _media,
                    label: 'Community Photos',
                  ),
                  const SizedBox(height: 16),
                  const Divider(),
                  const SizedBox(height: 8),
                  Text(
                    'Events',
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),

                  // Filter chips
                  SizedBox(
                    height: 36,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        _buildFilterChip('All', null),
                        const SizedBox(width: 6),
                        _buildFilterChip('Today', 'today'),
                        const SizedBox(width: 6),
                        _buildFilterChip('Upcoming', 'upcoming'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),

                  if (_events.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text('No events in this community.',
                            style: TextStyle(color: Colors.grey[500])),
                      ),
                    )
                  else
                    ..._buildEventGrid(),
                ],
              ),
            ),
          ),
        ],
      ),
        ),
    );
  }

  Widget _buildFollowButton() {
    return SizedBox(
      height: 32,
      child: _isMember
          ? OutlinedButton.icon(
              onPressed: _followToggling ? null : _toggleFollow,
              icon: _followToggling
                  ? const SizedBox(
                      width: 12, height: 12,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check, size: 14),
              label: const Text('Following', style: TextStyle(fontSize: 12)),
              style: OutlinedButton.styleFrom(
                foregroundColor: const Color(0xFFC2185B),
                side: const BorderSide(color: Color(0xFFC2185B)),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            )
          : ElevatedButton.icon(
              onPressed: _followToggling ? null : _toggleFollow,
              icon: _followToggling
                  ? const SizedBox(
                      width: 12, height: 12,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Icon(Icons.add, size: 14),
              label: const Text('Follow', style: TextStyle(fontSize: 12)),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFFC2185B),
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            ),
    );
  }

  Widget _buildShareButton() {
    final name = _community?['name'] as String? ?? 'Community';
    final id = widget.id;
    return SizedBox(
      height: 32,
      child: IconButton(
        icon: const Icon(Icons.share, size: 18),
        style: IconButton.styleFrom(
          foregroundColor: const Color(0xFFC2185B),
          backgroundColor: const Color(0xFFC2185B).withValues(alpha: 0.1),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
          ),
        ),
        onPressed: () {
          final url = buildShareUrl('communities', id);
          Share.share('Join $name on Cluvo!\n$url',
              subject: 'Join $name on Cluvo');
        },
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
            fontSize: 56,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
    );
  }

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 80,
            child: Text(label,
                style: TextStyle(color: Colors.grey[500], fontSize: 13)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
  }

  String _categorize(Event event, DateTime today) {
    final startDay = DateTime(event.startDate.year, event.startDate.month, event.startDate.day);
    if (startDay.isBefore(today)) return 'past';
    if (startDay.isAtSameMomentAs(today)) return 'today';
    return 'upcoming';
  }

  Widget _buildFilterChip(String label, String? category) {
    final selected = _eventFilter == category;
    return GestureDetector(
      onTap: () => setState(() => _eventFilter = selected ? null : category),
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

  List<Widget> _buildEventGrid() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final filtered = _eventFilter == null
        ? _events
        : _events.where((e) => _categorize(e, today) == _eventFilter).toList();

    if (filtered.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 24),
          child: Center(
            child: Text(
              'No ${_eventFilter ?? ""} events.',
              style: TextStyle(color: Colors.grey[500]),
            ),
          ),
        ),
      ];
    }

    final rows = <Widget>[];
    for (var i = 0; i < filtered.length; i += 3) {
      final rowEvents = filtered.sublist(i, i + 3 > filtered.length ? filtered.length : i + 3);
      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: rowEvents.map((e) => Expanded(child: _buildGridCard(e))).toList(),
          ),
        ),
      );
    }
    return rows;
  }

  Widget _buildGridCard(Event e) {
    final title = e.title;
    final imageUrl = e.imageUrl;
    final today = DateTime.now();
    final todayDay = DateTime(today.year, today.month, today.day);
    final eventDay = DateTime(e.startDate.year, e.startDate.month, e.startDate.day);
    final isPast = eventDay.isBefore(todayDay);
    return RepaintBoundary(
      child: Padding(
        padding: const EdgeInsets.only(right: 8),
      child: Card(
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
        ),
        child: InkWell(
          onTap: () => context.push('/events/${e.id}'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AspectRatio(
                aspectRatio: 1,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    imageUrl != null && imageUrl.isNotEmpty
                        ? CachedNetworkImage(
                            imageUrl: imageUrl,
                            fit: BoxFit.cover,
                            width: double.infinity,
                            errorWidget: (_, __, ___) =>
                                _buildGridFallback(title),
                          )
                        : _buildGridFallback(title),
                    if (isPast)
                      Container(
                        color: Colors.black45,
                        child: Center(
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: Colors.red.withValues(alpha: 0.85),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: const Text(
                              'Closed',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(6, 5, 6, 5),
                child: Opacity(
                  opacity: isPast ? 0.5 : 1.0,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        height: 1.2,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _formatShortDate(e),
                      style: TextStyle(
                        fontSize: 8,
                        color: Colors.grey[400],
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      e.price > 0
                          ? '₹${(e.price / 100).toStringAsFixed(0)}'
                          : 'Free',
                      style: TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w600,
                        color: e.price > 0
                            ? const Color(0xFFC2185B)
                            : Colors.green,
                      ),
                    ),
                  ],
                ),
                ),
              ),
            ],
          ),
        ),
      ),
      ),
    );
  }

  Widget _buildGridFallback(String title) {
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
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
    );
  }

  Widget _buildSkeleton() {
    return ListView(
      physics: const NeverScrollableScrollPhysics(),
      children: [
        Container(
          height: 220,
          color: Colors.grey[200],
        ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(height: 20, width: 200, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              const SizedBox(height: 12),
              Container(height: 14, width: double.infinity, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              const SizedBox(height: 8),
              Container(height: 14, width: 160, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              const SizedBox(height: 20),
              ...List.generate(4, (_) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Container(height: 14, width: double.infinity, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              )),
              const SizedBox(height: 20),
              Row(
                children: List.generate(3, (_) => Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Card(
                      clipBehavior: Clip.antiAlias,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      child: Column(
                        children: [
                          AspectRatio(aspectRatio: 1, child: Container(color: Colors.grey[200])),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(6, 5, 6, 5),
                            child: Column(
                              children: [
                                Container(height: 8, width: 50, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
                                const SizedBox(height: 4),
                                Container(height: 6, width: 30, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                )),
              ),
            ],
          ),
        ),
      ],
    );
  }

  String _formatShortDate(Event event) {
    return '${event.startDate.day} ${_months[event.startDate.month - 1]}';
  }
}
