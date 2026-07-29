import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme.dart';

class MediaGallery extends StatelessWidget {
  final List<Map<String, dynamic>> media;
  final String label;

  const MediaGallery({super.key, required this.media, this.label = 'Photos & Videos'});

  @override
  Widget build(BuildContext context) {
    if (media.isEmpty) return const SizedBox.shrink();

    final videos = media.where((m) => m['type'] == 'video').toList();
    final labelText = videos.isEmpty ? 'Photos' : label;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          labelText,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 110,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: media.length,
            separatorBuilder: (_, __) => const SizedBox(width: 8),
            itemBuilder: (context, index) {
              final item = media[index];
              final url = item['url'] as String;
              final isVideo = item['type'] == 'video';

              return GestureDetector(
                onTap: () => _openMedia(context, item),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: SizedBox(
                    width: 120,
                    height: 110,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        CachedNetworkImage(
                          imageUrl: url,
                          fit: BoxFit.cover,
                          width: 120,
                          height: 110,
                          placeholder: (_, __) => const SizedBox(),
                          errorWidget: (_, __, ___) => Container(
                            color: CluvoTheme.primary.withValues(alpha: 0.1),
                            child: Icon(Icons.broken_image,
                                color: CluvoTheme.primary, size: 28),
                          ),
                        ),
                        if (isVideo)
                          Container(
                            decoration: BoxDecoration(
                              color: Colors.black26,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Center(
                              child: Icon(Icons.play_circle_fill,
                                  color: Colors.white, size: 36),
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
        const SizedBox(height: 16),
      ],
    );
  }

  void _openMedia(BuildContext context, Map<String, dynamic> item) {
    final url = item['url'] as String;
    final isVideo = item['type'] == 'video';

    if (isVideo) {
      _openVideo(context, url);
    } else {
      _openImage(context, url);
    }
  }

  void _openImage(BuildContext context, String url) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
            elevation: 0,
          ),
          body: Center(
            child: InteractiveViewer(
              child: CachedNetworkImage(
                imageUrl: url,
                fit: BoxFit.contain,
                placeholder: (_, __) => const Center(child: CircularProgressIndicator()),
                errorWidget: (_, __, ___) =>
                    const Center(child: Icon(Icons.broken_image, color: Colors.white, size: 48)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openVideo(BuildContext context, String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open video.')),
        );
      }
    }
  }
}
