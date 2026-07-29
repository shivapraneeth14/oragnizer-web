class CommunityMember {
  final String communityId;
  final String userId;
  final String role;
  final Map<String, bool> permissions;
  final DateTime joinedAt;

  CommunityMember({
    required this.communityId,
    required this.userId,
    this.role = 'MEMBER',
    this.permissions = const {},
    required this.joinedAt,
  });

  factory CommunityMember.fromMap(Map<String, dynamic> map) => CommunityMember(
    communityId: map['community_id'] as String,
    userId: map['user_id'] as String,
    role: map['role'] as String? ?? 'MEMBER',
    permissions: map['permissions'] != null
        ? Map<String, bool>.from(map['permissions'] as Map)
        : {},
    joinedAt: DateTime.parse(map['joined_at'] as String),
  );

  Map<String, dynamic> toMap() => {
    'community_id': communityId,
    'user_id': userId,
    'role': role,
    'permissions': permissions,
    'joined_at': joinedAt.toIso8601String(),
  };
}
