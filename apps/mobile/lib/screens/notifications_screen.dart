import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/notification_provider.dart';
import '../supabase_client.dart';
import '../theme.dart';
import '../models/models.dart';

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifications = ref.watch(notificationsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: notifications.when(
        data: (data) {
          if (data.isEmpty) {
            return const Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.notifications_none, size: 48, color: Colors.grey),
                  SizedBox(height: 12),
                  Text('No notifications yet.',
                      style: TextStyle(color: Colors.grey)),
                ],
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(notificationsProvider);
              ref.invalidate(unreadCountProvider);
              await ref.read(notificationsProvider.future);
            },
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: data.length,
              separatorBuilder: (_, __) => const Divider(height: 1, indent: 16),
              itemBuilder: (context, index) {
                final n = data[index];
                final isRead = n.read;
                final type = n.type;

                return ListTile(
                  leading: _iconForType(type, isRead),
                  title: Text(
                    n.title,
                    style: TextStyle(
                      fontWeight: isRead ? FontWeight.normal : FontWeight.w600,
                      fontSize: 14,
                    ),
                  ),
                  subtitle: Text(
                    n.body ?? '',
                    style: TextStyle(fontSize: 12, color: Colors.grey[600]),
                  ),
                  trailing: Text(
                    _timeAgo(n),
                    style: TextStyle(fontSize: 11, color: Colors.grey[400]),
                  ),
                  onTap: () => _markRead(n, ref),
                );
              },
            ),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Text('Could not load notifications.\n$e',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey[600])),
          ),
        ),
      ),
    );
  }

  Widget _iconForType(String type, bool isRead) {
    IconData icon;
    Color color;
    switch (type) {
      case 'new_event':
        icon = Icons.event;
        color = CluvoTheme.primary;
        break;
      case 'new_media':
        icon = Icons.photo_library;
        color = Colors.blue;
        break;
      case 'registration_confirmed':
        icon = Icons.check_circle;
        color = Colors.green;
        break;
      case 'event_cancelled':
        icon = Icons.cancel;
        color = Colors.red;
        break;
      case 'removed_from_community':
        icon = Icons.person_remove;
        color = Colors.red;
        break;
      default:
        icon = Icons.notifications;
        color = Colors.grey;
    }
    return CircleAvatar(
      radius: 18,
      backgroundColor: color.withValues(alpha: 0.15),
      child: Icon(icon, size: 18, color: color),
    );
  }

  void _markRead(AppNotification n, WidgetRef ref) async {
    if (n.read) return;
    try {
      await supabase.from('notifications').update({'read': true}).eq('id', n.id);
      ref.invalidate(unreadCountProvider);
      ref.invalidate(notificationsProvider);
    } catch (_) {
    }
  }

  String _timeAgo(AppNotification notification) {
    final dt = notification.createdAt;
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m';
    if (diff.inHours < 24) return '${diff.inHours}h';
    if (diff.inDays < 7) return '${diff.inDays}d';
    return '${dt.day}/${dt.month}';
  }
}
