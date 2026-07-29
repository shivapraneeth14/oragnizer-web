class AppNotification {
  final String id;
  final String userId;
  final String type;
  final String title;
  final String? body;
  final Map<String, dynamic>? payload;
  final bool read;
  final DateTime createdAt;

  AppNotification({
    required this.id,
    required this.userId,
    required this.type,
    required this.title,
    this.body,
    this.payload,
    this.read = false,
    required this.createdAt,
  });

  factory AppNotification.fromMap(Map<String, dynamic> map) => AppNotification(
    id: map['id'] as String,
    userId: map['user_id'] as String,
    type: map['type'] as String,
    title: map['title'] as String,
    body: map['body'] as String?,
    payload: map['payload'] as Map<String, dynamic>?,
    read: map['read'] as bool? ?? false,
    createdAt: DateTime.parse(map['created_at'] as String),
  );

  Map<String, dynamic> toMap() => {
    'id': id,
    'user_id': userId,
    'type': type,
    'title': title,
    if (body != null) 'body': body,
    if (payload != null) 'payload': payload,
    'read': read,
    'created_at': createdAt.toIso8601String(),
  };
}
