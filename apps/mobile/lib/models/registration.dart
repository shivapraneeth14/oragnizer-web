class Registration {
  final String id;
  final String eventId;
  final String userId;
  final String status;
  final String? qrCode;
  final bool checkedIn;
  final DateTime? checkedInAt;
  final DateTime registeredAt;
  final DateTime updatedAt;
  final DateTime? deletedAt;

  Registration({
    required this.id,
    required this.eventId,
    required this.userId,
    this.status = 'pending',
    this.qrCode,
    this.checkedIn = false,
    this.checkedInAt,
    required this.registeredAt,
    required this.updatedAt,
    this.deletedAt,
  });

  factory Registration.fromMap(Map<String, dynamic> map) => Registration(
    id: map['id'] as String,
    eventId: map['event_id'] as String,
    userId: map['user_id'] as String,
    status: map['status'] as String? ?? 'pending',
    qrCode: map['qr_code'] as String?,
    checkedIn: map['checked_in'] as bool? ?? false,
    checkedInAt: map['checked_in_at'] != null ? DateTime.parse(map['checked_in_at'] as String) : null,
    registeredAt: DateTime.parse(map['registered_at'] as String),
    updatedAt: DateTime.parse(map['updated_at'] as String),
    deletedAt: map['deleted_at'] != null ? DateTime.parse(map['deleted_at'] as String) : null,
  );

  Map<String, dynamic> toMap() => {
    'id': id,
    'event_id': eventId,
    'user_id': userId,
    'status': status,
    if (qrCode != null) 'qr_code': qrCode,
    'checked_in': checkedIn,
    if (checkedInAt != null) 'checked_in_at': checkedInAt!.toIso8601String(),
    'registered_at': registeredAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
    if (deletedAt != null) 'deleted_at': deletedAt!.toIso8601String(),
  };
}
