import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { BookIndexService } from './book-index.service';
import { GeminiClient, LlmClient } from './llm.client';

@Module({
  controllers: [AssistantController],
  providers: [
    AssistantService,
    BookIndexService,
    { provide: LlmClient, useClass: GeminiClient },
  ],
})
export class AssistantModule {}
