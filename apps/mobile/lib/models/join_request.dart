class JoinRequest {
  final String id;
  final String communityId;
  final String userId;
  final String status;
  final DateTime createdAt;

  JoinRequest({
    required this.id,
    required this.communityId,
    required this.userId,
    this.status = 'pending',
    required this.createdAt,
  });

  factory JoinRequest.fromMap(Map<String, dynamic> map) => JoinRequest(
    id: map['id'] as String,
    communityId: map['community_id'] as String,
    userId: map['user_id'] as String,
    status: map['status'] as String? ?? 'pending',
    createdAt: DateTime.parse(map['created_at'] as String),
  );

  Map<String, dynamic> toMap() => {
    'id': id,
    'community_id': communityId,
    'user_id': userId,
    'status': status,
    'created_at': createdAt.toIso8601String(),
  };
}
