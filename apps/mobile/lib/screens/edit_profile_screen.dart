import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import '../providers/profile_provider.dart';
import '../supabase_client.dart';
import '../theme.dart';
import '../services/cloudinary.dart';

class EditProfileScreen extends ConsumerStatefulWidget {
  const EditProfileScreen({super.key});

  @override
  ConsumerState<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends ConsumerState<EditProfileScreen> {
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();
  final _usernameController = TextEditingController();
  String? _avatarUrl;
  String? _initialUsername;
  bool _usernameAvailable = true;
  bool _checkingUsername = false;
  bool _saving = false;
  bool _uploading = false;
  Timer? _usernameTimer;

  @override
  void initState() {
    super.initState();
    final profile = ref.read(profileProvider).valueOrNull;
    if (profile != null) {
      _firstNameController.text = profile.firstName ?? '';
      _lastNameController.text = profile.lastName ?? '';
      _usernameController.text = profile.username ?? '';
      _initialUsername = profile.username ?? '';
      _avatarUrl = profile.avatarUrl;
    }
  }

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
    _usernameController.dispose();
    _usernameTimer?.cancel();
    super.dispose();
  }

  void _onUsernameChanged(String value) {
    _usernameTimer?.cancel();
    if (value.trim() == _initialUsername) {
      setState(() {
        _checkingUsername = false;
        _usernameAvailable = true;
      });
      return;
    }
    if (value.trim().length < 3) {
      setState(() {
        _checkingUsername = false;
        _usernameAvailable = false;
      });
      return;
    }
    setState(() => _checkingUsername = true);
    _usernameTimer = Timer(const Duration(milliseconds: 500), () async {
      try {
        final res = await supabase.functions.invoke(
          'check-username',
          body: {'username': value.trim()},
        );
        if (!mounted) return;
        setState(() {
          _checkingUsername = false;
          _usernameAvailable = res.data['available'] == true;
        });
      } catch (_) {
        if (!mounted) return;
        setState(() {
          _checkingUsername = false;
          _usernameAvailable = false;
        });
      }
    });
  }

  Future<void> _pickImage() async {
    final picker = ImagePicker();
    final picked = await picker.pickImage(source: ImageSource.gallery, maxWidth: 512, maxHeight: 512);
    if (picked == null) return;
    setState(() => _uploading = true);
    try {
      final url = await uploadToCloudinary(File(picked.path));
      if (!mounted) return;
      await supabase.from('profiles').update({'avatar_url': url}).eq(
        'id',
        supabase.auth.currentSession!.user.id,
      );
      final _ = await ref.refresh(profileProvider.future);
      setState(() {
        _avatarUrl = url;
        _uploading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _uploading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Upload failed: $e'), backgroundColor: Colors.red[700]),
      );
    }
  }

  Future<void> _save() async {
    final firstName = _firstNameController.text.trim();
    final lastName = _lastNameController.text.trim();
    final username = _usernameController.text.trim();

    if (firstName.isEmpty) {
      _showError('First name is required.');
      return;
    }
    if (lastName.isEmpty) {
      _showError('Last name is required.');
      return;
    }
    if (username.isEmpty) {
      _showError('Username is required.');
      return;
    }
    if (!_usernameAvailable) {
      _showError('Username is already taken.');
      return;
    }

    setState(() => _saving = true);
    try {
      await supabase.from('profiles').update({
        'first_name': firstName,
        'last_name': lastName,
        if (username != _initialUsername) 'username': username,
      }).eq('id', supabase.auth.currentSession!.user.id);
      final _ = await ref.refresh(profileProvider.future);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Profile updated.'),
          backgroundColor: Color(0xFF10B981),
        ),
      );
      context.pop();
    } catch (e) {
      _showError('Failed to save: $e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.red[700]),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Edit Profile'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            const SizedBox(height: 16),
            GestureDetector(
              onTap: _uploading ? null : _pickImage,
              child: Stack(
                children: [
                  CircleAvatar(
                    radius: 50,
                    backgroundColor: CluvoTheme.primary.withValues(alpha: 0.15),
                    backgroundImage: _avatarUrl != null && _avatarUrl!.isNotEmpty
                        ? NetworkImage(_avatarUrl!)
                        : null,
                    child: _avatarUrl == null || _avatarUrl!.isEmpty
                        ? Text(
                            _firstNameController.text.isNotEmpty
                                ? _firstNameController.text[0].toUpperCase()
                                : 'U',
                            style: const TextStyle(
                              fontSize: 36,
                              fontWeight: FontWeight.bold,
                              color: CluvoTheme.primary,
                            ),
                          )
                        : null,
                  ),
                  if (_uploading)
                    Positioned.fill(
                      child: Container(
                        decoration: const BoxDecoration(
                          color: Colors.black26,
                          shape: BoxShape.circle,
                        ),
                        child: const Center(
                          child: SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                    ),
                  Positioned(
                    bottom: 0,
                    right: 0,
                    child: Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: CluvoTheme.primary,
                        shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 2),
                      ),
                      child: const Icon(Icons.camera_alt, size: 16, color: Colors.white),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            GestureDetector(
              onTap: _uploading ? null : _pickImage,
              child: Text(
                _uploading ? 'Uploading...' : 'Tap to change photo',
                style: TextStyle(fontSize: 12, color: Colors.grey[500]),
              ),
            ),
            const SizedBox(height: 32),
            _buildLabel('First Name'),
            const SizedBox(height: 6),
            TextField(
              controller: _firstNameController,
              decoration: _inputDecoration(),
            ),
            const SizedBox(height: 20),
            _buildLabel('Last Name'),
            const SizedBox(height: 6),
            TextField(
              controller: _lastNameController,
              decoration: _inputDecoration(),
            ),
            const SizedBox(height: 20),
            _buildLabel('Username'),
            const SizedBox(height: 6),
            TextField(
              controller: _usernameController,
              onChanged: _onUsernameChanged,
              decoration: _inputDecoration().copyWith(
                suffixIcon: _checkingUsername
                    ? const Padding(
                        padding: EdgeInsets.all(14),
                        child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : _usernameController.text.trim() != _initialUsername
                        ? Icon(
                            _usernameAvailable
                                ? Icons.check_circle
                                : Icons.cancel,
                            color: _usernameAvailable
                                ? Colors.green
                                : Colors.red,
                            size: 20,
                          )
                        : null,
              ),
            ),
            const SizedBox(height: 32),
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text(
                        'Save Changes',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLabel(String text) {
    return Text(
      text,
      style: const TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w500,
        color: CluvoTheme.textPrimary,
      ),
    );
  }

  InputDecoration _inputDecoration() {
    return InputDecoration(
      filled: true,
      fillColor: CluvoTheme.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: CluvoTheme.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: CluvoTheme.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: BorderSide(color: CluvoTheme.primary, width: 1.5),
      ),
    );
  }
}
