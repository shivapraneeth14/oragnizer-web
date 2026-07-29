import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import '../config.dart';

final _cloudName = AppConfig.cloudinaryCloudName;
final _uploadPreset = AppConfig.cloudinaryUploadPreset;
const _maxFileSize = 10 * 1024 * 1024; // 10 MB
const _allowedExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

Future<String> uploadToCloudinary(File image) async {
  final ext = image.path.split('.').last.toLowerCase();
  if (!_allowedExtensions.contains(ext)) {
    throw Exception('Only JPEG, PNG, WebP, and GIF images are allowed.');
  }
  final size = await image.length();
  if (size > _maxFileSize) {
    throw Exception('File is too large. Maximum size is 10 MB.');
  }

  final uri = Uri.parse('https://api.cloudinary.com/v1_1/$_cloudName/image/upload');
  final request = http.MultipartRequest('POST', uri)
    ..files.add(await http.MultipartFile.fromPath('file', image.path))
    ..fields['upload_preset'] = _uploadPreset;

  final response = await request.send().timeout(const Duration(seconds: 30));
  final body = await response.stream.bytesToString();
  final data = jsonDecode(body) as Map<String, dynamic>;

  if (response.statusCode != 200) {
    throw Exception(data['error']['message'] ?? 'Upload failed');
  }

  return data['secure_url'] as String;
}
