import type { UserResponseDto } from './common.dto';

/** Partial profile update body. */
export type UpdateProfileRequestDto = Partial<
  Pick<
    UserResponseDto,
    | 'name'
    | 'place'
    | 'address'
    | 'location'
    | 'age'
    | 'dateOfBirth'
    | 'bloodGroup'
    | 'profileImage'
    | 'gender'
    | 'email'
  >
>;

export type ProfileResponseDto = UserResponseDto;
