import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../providers/profile_provider.dart';
import '../providers/community_provider.dart';
import '../widgets/notification_bell.dart';
import '../models/models.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(profileProvider);
    final authState = ref.watch(authProvider);
    final myCommunities = ref.watch(myCommunitiesProvider);

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
      body: profile.when(
        data: (data) {
          final email = authState.session?.user.email ?? '';
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(profileProvider);
              ref.invalidate(myCommunitiesProvider);
              await ref.read(profileProvider.future);
            },
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(24),
              child: Column(
                children: [
                  const SizedBox(height: 20),
                  Stack(
                    children: [
                      CircleAvatar(
                        radius: 40,
                        backgroundColor: const Color(0xFFC2185B).withOpacity(0.15),
                        backgroundImage: data != null && data.avatarUrl != null && data.avatarUrl!.isNotEmpty
                            ? NetworkImage(data.avatarUrl!)
                            : null,
                        child: data == null || data.avatarUrl == null || data.avatarUrl!.isEmpty
                            ? Text(
                                email.isNotEmpty ? email[0].toUpperCase() : 'U',
                                style: const TextStyle(
                                  fontSize: 28,
                                  fontWeight: FontWeight.bold,
                                  color: Color(0xFFC2185B),
                                ),
                              )
                            : null,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Text(
                    data != null
                        ? '${data.firstName ?? ''} ${data.lastName ?? ''}'
                        : email,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    email,
                    style: TextStyle(color: Colors.grey[500], fontSize: 14),
                  ),
                  if (data != null && data.username != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      '@${data.username}',
                      style: TextStyle(color: Colors.grey[400], fontSize: 13),
                    ),
                  ],
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: () => context.push('/edit-profile'),
                      icon: const Icon(Icons.edit, size: 16),
                      label: const Text('Edit Profile', style: TextStyle(fontSize: 14)),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFFC2185B),
                        side: const BorderSide(color: Color(0xFFC2185B)),
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(8),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          Icon(Icons.calendar_today,
                              size: 16, color: Colors.grey[500]),
                          const SizedBox(width: 8),
                          Text(
                            'Joined ${data != null ? _formatDate(data.createdAt.toIso8601String()) : ''}',
                            style: TextStyle(
                                color: Colors.grey[600], fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                  myCommunities.when(
                    data: (communities) {
                      if (communities.isEmpty) return const SizedBox.shrink();
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(Icons.favorite, size: 16, color: Colors.grey[500]),
                              const SizedBox(width: 6),
                              Text(
                                'My Communities',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                  color: Colors.grey[700],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          ...communities.map((c) => _buildCommunityCard(context, c)),
                        ],
                      );
                    },
                    loading: () => const SizedBox(
                      height: 40,
                      child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
                    ),
                    error: (e, _) => Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Column(
                        children: [
                          Text('Could not load communities.',
                              style: TextStyle(color: Colors.grey[500], fontSize: 13)),
                          const SizedBox(height: 8),
                          TextButton.icon(
                            onPressed: () {
                              ref.invalidate(myCommunitiesProvider);
                            },
                            icon: const Icon(Icons.refresh, size: 14),
                            label: const Text('Retry', style: TextStyle(fontSize: 13)),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: () async {
                        await ref.read(authProvider.notifier).signOut();
                        if (context.mounted) context.go('/login');
                      },
                      icon: const Icon(Icons.logout, size: 18),
                      label: const Text('Sign Out'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.red,
                        side: const BorderSide(color: Colors.red),
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 32),
                ],
              ),
            ),
          );
        },
        loading: () => _buildSkeleton(),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, size: 40, color: Colors.grey),
                const SizedBox(height: 12),
                Text('Error: $e',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey[600])),
                const SizedBox(height: 16),
                OutlinedButton.icon(
                  onPressed: () {
                    ref.invalidate(profileProvider);
                    ref.invalidate(myCommunitiesProvider);
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
        ),
      );
    }

    Widget _buildSkeleton() {
    return ListView(
      physics: const NeverScrollableScrollPhysics(),
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 20),
        CircleAvatar(radius: 40, backgroundColor: Colors.grey[200]),
        const SizedBox(height: 16),
        Center(child: Container(height: 16, width: 160, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4)))),
        const SizedBox(height: 6),
        Center(child: Container(height: 12, width: 200, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4)))),
        const SizedBox(height: 24),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Container(height: 14, width: 120, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
          ),
        ),
      ],
    );
  }

  Widget _buildCommunityCard(BuildContext context, Community c) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
      ),
      child: InkWell(
        onTap: () => context.push('/communities/${c.id}'),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: const Color(0xFFC2185B).withOpacity(0.1),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Center(
                  child: Text(
                    c.name.isNotEmpty
                        ? c.name[0].toUpperCase()
                        : 'C',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFFC2185B),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      c.name,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (c.city != null || c.country != null)
                      Text(
                        '${c.city ?? ''}${c.city != null && c.country != null ? ', ' : ''}${c.country ?? ''}',
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.grey[500],
                        ),
                      ),
                  ],
                ),
              ),
              Text(
                '${c.memberCount} members',
                style: TextStyle(
                    fontSize: 11,
                    color: Colors.grey[400],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return '';
    return '${dt.day}/${dt.month}/${dt.year}';
  }
}
