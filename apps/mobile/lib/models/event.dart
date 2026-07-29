class Event {
  final String id;
  final String communityId;
  final String title;
  final String? description;
  final String? imageUrl;
  final DateTime startDate;
  final DateTime? endDate;
  final String? location;
  final int? capacity;
  final double price;
  final int bookedCount;
  final String status;
  final String createdBy;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? deletedAt;
  final String? communityName;

  Event({
    required this.id,
    required this.communityId,
    required this.title,
    this.description,
    this.imageUrl,
    required this.startDate,
    this.endDate,
    this.location,
    this.capacity,
    this.price = 0,
    this.bookedCount = 0,
    this.status = 'draft',
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
    this.deletedAt,
    this.communityName,
  });

  factory Event.fromMap(Map<String, dynamic> map) {
    String? communityName;
    if (map['communities'] != null) {
      final communities = map['communities'];
      if (communities is Map<String, dynamic>) {
        communityName = communities['name'] as String?;
      }
    }
    return Event(
      id: map['id'] as String,
      communityId: map['community_id'] as String,
      title: map['title'] as String,
      description: map['description'] as String?,
      imageUrl: map['image_url'] as String?,
      startDate: DateTime.parse(map['start_date'] as String),
      endDate: map['end_date'] != null ? DateTime.parse(map['end_date'] as String) : null,
      location: map['location'] as String?,
      capacity: map['capacity'] as int?,
      price: (map['price'] as num?)?.toDouble() ?? 0,
      bookedCount: map['booked_count'] as int? ?? 0,
      status: map['status'] as String? ?? 'draft',
      createdBy: map['created_by'] as String,
      createdAt: DateTime.parse(map['created_at'] as String),
      updatedAt: DateTime.parse(map['updated_at'] as String),
      deletedAt: map['deleted_at'] != null ? DateTime.parse(map['deleted_at'] as String) : null,
      communityName: communityName,
    );
  }

  Map<String, dynamic> toMap() => {
    'id': id,
    'community_id': communityId,
    'title': title,
    if (description != null) 'description': description,
    if (imageUrl != null) 'image_url': imageUrl,
    'start_date': startDate.toIso8601String(),
    if (endDate != null) 'end_date': endDate!.toIso8601String(),
    if (location != null) 'location': location,
    if (capacity != null) 'capacity': capacity,
    'price': price,
    'booked_count': bookedCount,
    'status': status,
    'created_by': createdBy,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
    if (deletedAt != null) 'deleted_at': deletedAt!.toIso8601String(),
  };
}
