class Community {
  final String id;
  final String name;
  final String? description;
  final String? location;
  final String? bannerUrl;
  final String ownerId;
  final String visibility;
  final String verificationStatus;
  final int memberCount;
  final int eventCount;
  final String? category;
  final String? country;
  final String? state;
  final String? city;
  final String? contactEmail;
  final String? contactPhone;
  final List<String>? tags;
  final String? rules;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? deletedAt;

  Community({
    required this.id,
    required this.name,
    this.description,
    this.location,
    this.bannerUrl,
    required this.ownerId,
    this.visibility = 'public',
    this.verificationStatus = 'unverified',
    this.memberCount = 0,
    this.eventCount = 0,
    this.category,
    this.country,
    this.state,
    this.city,
    this.contactEmail,
    this.contactPhone,
    this.tags,
    this.rules,
    required this.createdAt,
    required this.updatedAt,
    this.deletedAt,
  });

  factory Community.fromMap(Map<String, dynamic> map) => Community(
    id: map['id'] as String,
    name: map['name'] as String,
    description: map['description'] as String?,
    location: map['location'] as String?,
    bannerUrl: map['banner_url'] as String?,
    ownerId: map['owner_id'] as String,
    visibility: map['visibility'] as String? ?? 'public',
    verificationStatus: map['verification_status'] as String? ?? 'unverified',
    memberCount: map['member_count'] as int? ?? 0,
    eventCount: map['event_count'] as int? ?? 0,
    category: map['category'] as String?,
    country: map['country'] as String?,
    state: map['state'] as String?,
    city: map['city'] as String?,
    contactEmail: map['contact_email'] as String?,
    contactPhone: map['contact_phone'] as String?,
    tags: map['tags'] != null ? List<String>.from(map['tags'] as List) : null,
    rules: map['rules'] as String?,
    createdAt: DateTime.parse(map['created_at'] as String),
    updatedAt: DateTime.parse(map['updated_at'] as String),
    deletedAt: map['deleted_at'] != null ? DateTime.parse(map['deleted_at'] as String) : null,
  );

  Map<String, dynamic> toMap() => {
    'id': id,
    'name': name,
    if (description != null) 'description': description,
    if (location != null) 'location': location,
    if (bannerUrl != null) 'banner_url': bannerUrl,
    'owner_id': ownerId,
    'visibility': visibility,
    'verification_status': verificationStatus,
    'member_count': memberCount,
    'event_count': eventCount,
    if (category != null) 'category': category,
    if (country != null) 'country': country,
    if (state != null) 'state': state,
    if (city != null) 'city': city,
    if (contactEmail != null) 'contact_email': contactEmail,
    if (contactPhone != null) 'contact_phone': contactPhone,
    if (tags != null) 'tags': tags,
    if (rules != null) 'rules': rules,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
    if (deletedAt != null) 'deleted_at': deletedAt!.toIso8601String(),
  };
}
