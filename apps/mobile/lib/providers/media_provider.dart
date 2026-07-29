import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../supabase_client.dart';

final communityMediaProvider =
    FutureProvider.family<List<Map<String, dynamic>>, String>((ref, communityId) async {
  final response = await supabase
      .from('media')
      .select('*')
      .eq('mediable_type', 'community')
      .eq('mediable_id', communityId)
      .order('sort_order', ascending: true)
      .limit(50);
  return (response as List).cast<Map<String, dynamic>>();
});

final eventMediaProvider =
    FutureProvider.family<List<Map<String, dynamic>>, String>((ref, eventId) async {
  final response = await supabase
      .from('media')
      .select('*')
      .eq('mediable_type', 'event')
      .eq('mediable_id', eventId)
      .order('sort_order', ascending: true);
  return (response as List).cast<Map<String, dynamic>>();
});
