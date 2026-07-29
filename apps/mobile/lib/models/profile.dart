class Profile {
  final String id;
  final String email;
  final String? firstName;
  final String? lastName;
  final String? username;
  final String? avatarUrl;
  final bool isAdmin;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? deletedAt;

  Profile({
    required this.id,
    required this.email,
    this.firstName,
    this.lastName,
    this.username,
    this.avatarUrl,
    this.isAdmin = false,
    required this.createdAt,
    required this.updatedAt,
    this.deletedAt,
  });

  factory Profile.fromMap(Map<String, dynamic> map) => Profile(
    id: map['id'] as String,
    email: map['email'] as String,
    firstName: map['first_name'] as String?,
    lastName: map['last_name'] as String?,
    username: map['username'] as String?,
    avatarUrl: map['avatar_url'] as String?,
    isAdmin: map['is_admin'] as bool? ?? false,
    createdAt: DateTime.parse(map['created_at'] as String),
    updatedAt: DateTime.parse(map['updated_at'] as String),
    deletedAt: map['deleted_at'] != null ? DateTime.parse(map['deleted_at'] as String) : null,
  );

  Map<String, dynamic> toMap() => {
    'id': id,
    'email': email,
    'first_name': firstName,
    'last_name': lastName,
    'username': username,
    'avatar_url': avatarUrl,
    'is_admin': isAdmin,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
    if (deletedAt != null) 'deleted_at': deletedAt!.toIso8601String(),
  };
}
