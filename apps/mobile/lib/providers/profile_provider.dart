import 'dart:io';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../supabase_client.dart';
import '../models/models.dart';
import '../services/cloudinary.dart';

final profileProvider = FutureProvider<Profile?>((ref) async {
  final session = supabase.auth.currentSession;
  if (session == null) return null;
  final response = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();
  final map = response as Map<String, dynamic>?;
  return map != null ? Profile.fromMap(map) : null;
});

final profileNotifierProvider =
    StateNotifierProvider<ProfileNotifier, AsyncValue<void>>((ref) {
  return ProfileNotifier(ref);
});

class ProfileNotifier extends StateNotifier<AsyncValue<void>> {
  final Ref _ref;

  ProfileNotifier(this._ref) : super(const AsyncValue.data(null));

  Future<void> updateProfile(Map<String, dynamic> updates) async {
    final session = supabase.auth.currentSession;
    if (session == null) return;
    state = const AsyncValue.loading();
    try {
      await supabase
          .from('profiles')
          .update(updates)
          .eq('id', session.user.id);
      _ref.invalidate(profileProvider);
      state = const AsyncValue.data(null);
    } catch (e) {
      state = AsyncValue.error(e, StackTrace.current);
    }
  }

  Future<String?> uploadAvatar(File image) async {
    final session = supabase.auth.currentSession;
    if (session == null) return null;
    state = const AsyncValue.loading();
    try {
      final url = await uploadToCloudinary(image);
      await supabase
          .from('profiles')
          .update({'avatar_url': url})
          .eq('id', session.user.id);
      _ref.invalidate(profileProvider);
      state = const AsyncValue.data(null);
      return url;
    } catch (e) {
      state = AsyncValue.error(e, StackTrace.current);
      return null;
    }
  }
}
