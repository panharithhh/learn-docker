import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const NOT_BLANK = /\S/;

export class BookLookupQueryDto {
  @ApiProperty({ example: 'Can I borrow The Little Prince?' })
  @IsString()
  @MaxLength(200)
  @Matches(NOT_BLANK, { message: 'q must not be blank' })
  q: string;

  @ApiPropertyOptional({ default: 5, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit: number = 5;
}

export class ChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  content: string;
}

export class ChatRequestDto {
  @ApiProperty({ example: 'Do you have anything about Cambodian history?' })
  @IsString()
  @MaxLength(500)
  @Matches(NOT_BLANK, { message: 'message must not be blank' })
  message: string;

  @ApiPropertyOptional({
    type: [ChatTurnDto],
    description: 'Earlier turns, oldest first (up to 6)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history: ChatTurnDto[] = [];
}
