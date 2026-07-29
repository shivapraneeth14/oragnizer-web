import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../supabase_client.dart';
import '../models/models.dart';

final notificationsProvider = FutureProvider<List<AppNotification>>((ref) async {
  final session = supabase.auth.currentSession;
  if (session == null) return [];
  final response = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', ascending: false)
      .limit(50);
  return (response as List).cast<Map<String, dynamic>>().map((e) => AppNotification.fromMap(e)).toList();
});

final unreadCountProvider = FutureProvider<int>((ref) async {
  final session = supabase.auth.currentSession;
  if (session == null) return 0;
  final response = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', session.user.id)
      .eq('read', false);
  return (response as List).length;
});

final notificationRefreshProvider = Provider<void>((ref) {
  ref.invalidate(notificationsProvider);
  ref.invalidate(unreadCountProvider);
});
