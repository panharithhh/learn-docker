import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LogActivity } from '../dashboard/decorators/log-activity.decorator';
import { RoleName } from '../common/constants';
import type { AuthUser } from '../auth/types/auth-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AssistantService, type AssistantEvent } from './assistant.service';
import { BookLookupQueryDto, ChatRequestDto } from './dto/assistant.dto';

@ApiTags('assistant')
@ApiBearerAuth()
@Roles(RoleName.MEMBER, RoleName.LIBRARIAN, RoleName.ADMIN)
@Controller('assistant')
export class AssistantController {
  private readonly logger = new Logger('Assistant');

  constructor(private readonly assistant: AssistantService) {}

  /** The books a question is about, with live copies and a borrow verdict for the caller. No chat model involved. */
  @Get('books')
  lookup(@CurrentUser() user: AuthUser, @Query() query: BookLookupQueryDto) {
    return this.assistant.lookup(user, query.q, query.limit);
  }

  /**
   * Answers as a server-sent event stream: `books` (the lookup) first, then `token`
   * events as the model writes, then `done` with timings, or `error`.
   */
  @Post('chat')
  @ApiProduces('text/event-stream')
  @LogActivity({ skip: true })
  async chat(
    @CurrentUser() user: AuthUser,
    @Body() body: ChatRequestDto,
    @Res() response: Response,
  ) {
    response.status(200).set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();

    // Stop generating as soon as the member closes the page
    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    const send = ({
      type,
      data,
    }: AssistantEvent | { type: 'error'; data: unknown }) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      await this.assistant.answer(
        user,
        body.message,
        body.history,
        send,
        abort.signal,
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        if (status >= 500)
          this.logger.error(
            `Chat failed: ${(error as Error).message}`,
            (error as Error).stack,
          );
        send({
          type: 'error',
          data: {
            status,
            message:
              status === 500
                ? 'The assistant failed. Try again.'
                : (error as Error).message,
          },
        });
      }
    } finally {
      response.end();
    }
  }
}
