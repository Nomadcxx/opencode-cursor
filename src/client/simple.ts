import { spawn } from 'child_process';
import { LineBuffer } from '../streaming/line-buffer.js';
import { parseStreamJsonLine } from '../streaming/parser.js';
import {
  extractText,
  isAssistantText,
  type StreamJsonEvent,
} from '../streaming/types.js';
import { createLogger } from '../utils/logger.js';
import { resolveCursorAgentBinary } from '../utils/binary.js';

export interface CursorClientConfig {
  timeout?: number;
  maxRetries?: number;
  streamOutput?: boolean;
  cursorAgentPath?: string;
}

export interface CursorResponse {
  content: string;
  done: boolean;
  error?: string;
}

export class SimpleCursorClient {
  private config: Required<CursorClientConfig>;
  private log: ReturnType<typeof createLogger>;

  constructor(config: CursorClientConfig = {}) {
    this.config = {
      timeout: 30000,
      maxRetries: 3,
      streamOutput: true,
      cursorAgentPath: resolveCursorAgentBinary(),
      ...config
    };

    this.log = createLogger('cursor-client');
  }

  async *executePromptStream(prompt: string, options: {
    cwd?: string;
    model?: string;
    mode?: 'default' | 'plan' | 'ask';
    resumeId?: string;
  } = {}): AsyncGenerator<StreamJsonEvent, void, unknown> {
    // Input validation
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    const {
      cwd = process.cwd(),
      model = 'auto',
      mode = 'default',
      resumeId
    } = options;

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--model',
      model
    ];

    if (mode === 'plan') {
      args.push('--plan');
    } else if (mode === 'ask') {
      args.push('--mode', 'ask');
    }

    if (resumeId) {
      args.push('--resume', resumeId);
    }

    this.log.debug('Executing prompt stream', { promptLength: prompt.length, mode, model });

    const child = spawn(this.config.cursorAgentPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    if (prompt) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    let processError: Error | null = null;
    const lineBuffer = new LineBuffer();

    // Add stderr handling
    child.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      this.log.error('cursor-agent stderr', { error: errorMsg });
      processError = new Error(errorMsg);
    });

    // Add timeout
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      processError = new Error(`Timeout after ${this.config.timeout}ms`);
    }, this.config.timeout);

    const streamEnded = new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code !== 0 && !processError) {
          this.log.error('cursor-agent exited with non-zero code', { code });
          processError = new Error(`cursor-agent exited with code ${code}`);
        }
        resolve(code);
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        this.log.error('cursor-agent process error', { error: error.message });
        processError = error;
        resolve(null);
      });
    });

    for await (const chunk of child.stdout) {
      for (const line of lineBuffer.push(chunk)) {
        const event = parseStreamJsonLine(line);
        if (event) {
          yield event;
        } else {
          this.log.warn('Invalid JSON from cursor-agent', { line: line.substring(0, 100) });
        }
      }
    }

    for (const line of lineBuffer.flush()) {
      const event = parseStreamJsonLine(line);
      if (event) {
        yield event;
      } else {
        this.log.warn('Invalid JSON from cursor-agent', { line: line.substring(0, 100) });
      }
    }

    await streamEnded;

    if (processError) {
      throw processError;
    }
  }

  async executePrompt(prompt: string, options: {
    cwd?: string;
    model?: string;
    mode?: 'default' | 'plan' | 'ask';
    resumeId?: string;
  } = {}): Promise<CursorResponse> {
    // Input validation
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    const {
      cwd = process.cwd(),
      model = 'auto',
      mode = 'default',
      resumeId
    } = options;

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--model',
      model
    ];

    if (mode === 'plan') {
      args.push('--plan');
    } else if (mode === 'ask') {
      args.push('--mode', 'ask');
    }

    if (resumeId) {
      args.push('--resume', resumeId);
    }

    this.log.debug('Executing prompt', { promptLength: prompt.length, mode, model });

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cursorAgentPath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      if (prompt) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      child.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code !== 0) {
          reject(new Error(`cursor-agent exited with code ${code}: ${stderrBuffer}`));
          return;
        }

        try {
          const lines = stdoutBuffer.trim().split('\n');
          let content = '';
          
          for (const line of lines) {
            if (line.trim()) {
              const event = parseStreamJsonLine(line);
              if (event && isAssistantText(event)) {
                content = extractText(event);
              }
            }
          }

          resolve({
            content,
            done: true
          });
        } catch (error) {
          reject(new Error(`Failed to parse cursor-agent output: ${error}`));
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    return [
      { id: 'auto', name: 'Cursor Agent Auto' },
      { id: 'composer-1.5', name: 'Composer 1.5' },
      { id: 'opus-4.6-thinking', name: 'Claude 4.6 Opus (Thinking)' },
      { id: 'opus-4.6', name: 'Claude 4.6 Opus' },
      { id: 'sonnet-4.6', name: 'Claude 4.6 Sonnet' },
      { id: 'sonnet-4.6-thinking', name: 'Claude 4.6 Sonnet (Thinking)' },
      { id: 'opus-4.5', name: 'Claude 4.5 Opus' },
      { id: 'opus-4.5-thinking', name: 'Claude 4.5 Opus (Thinking)' },
      { id: 'sonnet-4.5', name: 'Claude 4.5 Sonnet' },
      { id: 'sonnet-4.5-thinking', name: 'Claude 4.5 Sonnet (Thinking)' },
      { id: 'gpt-5.4-high', name: 'GPT-5.4 High' },
      { id: 'gpt-5.4-medium', name: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      { id: 'gpt-5.2', name: 'GPT-5.2' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
      { id: 'grok', name: 'Grok' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
    ];
  }

  async validateInstallation(): Promise<boolean> {
    try {
      const testResponse = await this.executePrompt('test', { model: 'auto' });
      return !!testResponse.content;
    } catch (error) {
      this.log.error('Cursor installation validation failed:', error);
      return false;
    }
  }
}

export const createSimpleCursorClient = (config: CursorClientConfig = {}) => {
  return new SimpleCursorClient(config);
};
