import { Client, registerMethod, registerRequest } from './client'; // Assuming './client' is the correct path
import { Terminal } from './terminal'; // Assuming './terminal' is the correct path
import { TreeViewManager } from './treeView';
import * as tools from '../tools';
import * as y3 from 'y3-helper';
import * as l10n from '@vscode/l10n';

// Mock VS Code API
const mockEventEmitter = jest.fn(() => ({
    fire: jest.fn(),
    event: jest.fn(),
}));

const mockDisposable = jest.fn(() => ({
    dispose: jest.fn(),
}));

jest.mock('vscode', () => ({
    ...jest.requireActual('vscode'), // Keep actual enums if needed, or mock completely
    Disposable: mockDisposable,
    EventEmitter: mockEventEmitter,
    window: {
        createStatusBarItem: jest.fn(() => ({
            show: jest.fn(),
            dispose: jest.fn(),
            text: '',
            tooltip: '',
            command: '',
        })),
    },
    StatusBarAlignment: {
        Left: 1,
    },
    commands: {
        registerCommand: jest.fn(),
        executeCommand: jest.fn(),
    },
    env: {
        clipboard: {
            readText: jest.fn(),
            writeText: jest.fn(),
        },
    },
}));

// Mock dependencies
jest.mock('./terminal');
jest.mock('./treeView');
jest.mock('../tools', () => ({
    log: {
        info: jest.fn(),
        error: jest.fn(),
    },
}));
jest.mock('y3-helper', () => ({
    log: {
        info: jest.fn(),
        error: jest.fn(),
    },
}));
jest.mock('@vscode/l10n', () => ({
    t: jest.fn((s) => s), // Simple stub for localization
}));

// Mock the global methods and requests maps used by recv
const mockMethods = new Map();
const mockRequests = new Map();

// Override the actual registerMethod and registerRequest to use our mocks
jest.mock('./client', () => {
    const actual = jest.requireActual('./client');
    return {
        ...actual,
        registerMethod: jest.fn((method, handler) => mockMethods.set(method, handler)),
        registerRequest: jest.fn((method, handler) => mockRequests.set(method, handler)),
        Client: class MockClient extends actual.Client {
            // Override static properties/methods for isolation
            static allClients: MockClient[] = [];
            static button: any = undefined;
            static terminalHistory: { [name: string]: Terminal } = {};
            static updateButton = jest.fn();

            constructor(onSend: any) {
                super(onSend);
                // Ensure mocks are used for instance properties initialized in constructor
                (this as any).treeViewManager = new (TreeViewManager as any)();
                (this as any).terminal = new (Terminal as any)('Mock Terminal');
                (this as any).terminal.setApplyHandler = jest.fn();
                (this as any).terminal.multiMode = false; // Default value
                (this as any).terminal.enableInput = jest.fn();
                (this as any).terminal.print = jest.fn(async () => {}); // Mock print to return a promise
            }

            // Expose internal state for testing if needed
            get requestMap() { return (this as any).requestMap; }
            get printBuffer() { return (this as any).printBuffer; }
            set printBuffer(value: string[] | undefined) { (this as any).printBuffer = value; }
            get terminalInstance() { return (this as any).terminal; }
        }
    };
});

describe('Client', () => {
    let mockOnSend: jest.Mock;
    let client: Client;
    let mockTerminalInstance: jest.Mocked<Terminal>;
    let mockTreeViewManagerInstance: jest.Mocked<TreeViewManager>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockMethods.clear();
        mockRequests.clear();
        // Reset static state managed by the mock Client
        (Client as any).allClients = [];
        (Client as any).button = undefined;
        (Client as any).terminalHistory = {};
        (Client as any).updateButton = jest.fn();

        mockOnSend = jest.fn();
        client = new Client(mockOnSend);

        // Get the mocked instances created by the mock Client constructor
        mockTerminalInstance = (client as any).terminalInstance as jest.Mocked<Terminal>;
        mockTreeViewManagerInstance = (client as any).treeViewManager as jest.Mocked<TreeViewManager>;
    });

    it('should initialize correctly in the constructor', () => {
        expect(mockDisposable).toHaveBeenCalled(); // Base Disposable constructor
        expect(mockEventEmitter).toHaveBeenCalled(); // onDidUpdateName
        expect(Terminal).toHaveBeenCalledWith('Y3控制台'); // Default terminal name
        expect(mockTerminalInstance.setApplyHandler).toHaveBeenCalled();
        expect(mockTerminalInstance.enableInput).toHaveBeenCalled();
        expect(TreeViewManager).toHaveBeenCalledWith(client);
        expect((Client as any).allClients).toContain(client);
        expect((Client as any).updateButton).toHaveBeenCalled();
        expect((client as any).name).toBe('默认客户端');
    });

    it('should dispose correctly', () => {
        const mockCloseAllRequests = jest.fn();
        (client as any).closeAllRequests = mockCloseAllRequests; // Mock internal method

        client.dispose();

        expect(mockCloseAllRequests).toHaveBeenCalled();
        expect(mockTerminalInstance.dispose).toHaveBeenCalled();
        expect(mockTreeViewManagerInstance.dispose).toHaveBeenCalled();
        expect((Client as any).allClients).not.toContain(client);
        expect((Client as any).updateButton).toHaveBeenCalledTimes(2); // Once in constructor, once in dispose
        expect((Client as any).terminalHistory['默认客户端']).toBe(mockTerminalInstance);
        expect(mockTerminalInstance.disableInput).toHaveBeenCalled();
        expect(mockTerminalInstance.print).toHaveBeenCalledWith('\n⛔ 客户端已断开。下次启动游戏会复用此控制台。 ⛔\n');
    });

    describe('recv', () => {
        it('should handle a notification', async () => {
            const mockHandler = jest.fn(async () => { });
            mockMethods.set('testNotify', mockHandler);

            const notifyMsg = { method: 'testNotify', params: { data: 'some data' } };
            await client.recv(notifyMsg);

            expect(mockHandler).toHaveBeenCalledWith(client, notifyMsg.params);
            expect(mockOnSend).not.toHaveBeenCalled(); // No response for notify
        });

        it('should handle a request and send a successful response', async () => {
            const mockHandler = jest.fn(async (client, params) => `processed: ${params.value}`);
            mockMethods.set('testRequest', mockHandler);

            const requestMsg = { method: 'testRequest', id: 123, params: { value: 'input' } };
            await client.recv(requestMsg);

            expect(mockHandler).toHaveBeenCalledWith(client, requestMsg.params);
            expect(mockOnSend).toHaveBeenCalledWith({ id: 123, result: 'processed: input' });
        });

        it('should handle a request and send an error response if handler throws', async () => {
            const mockError = new Error('Handler failed');
            const mockHandler = jest.fn(async () => { throw mockError; });
            mockMethods.set('testRequest', mockHandler);

            const requestMsg = { method: 'testRequest', id: 124, params: {} };
            await client.recv(requestMsg);

            expect(mockHandler).toHaveBeenCalledWith(client, requestMsg.params);
            expect(tools.log.error).toHaveBeenCalledWith(mockError);
            expect(mockOnSend).toHaveBeenCalledWith({ id: 124, error: 'Handler failed' });
        });

        it('should handle a response and resolve the corresponding request promise', async () => {
            const requestPromise = client.request('someMethod', {});

            // Simulate receiving the response
            const responseMsg = { id: 0, result: 'request result' }; // requestID starts at 0
            await client.recv(responseMsg);

            const result = await requestPromise;
            expect(result).toBe('request result');
            expect((client as any).requestMap.size).toBe(0); // Handler should be removed
        });

        it('should handle an error response and resolve the corresponding request promise with undefined', async () => {
            const requestPromise = client.request('someMethod', {});

            // Simulate receiving the error response
            const responseMsg = { id: 0, error: 'request failed' };
            await client.recv(responseMsg);

            const result = await requestPromise;
            expect(result).toBeUndefined(); // Error responses resolve with undefined result
            expect(tools.log.error).toHaveBeenCalledWith('request failed');
            expect((client as any).requestMap.size).toBe(0); // Handler should be removed
        });

        it('should ignore response for unknown request id', async () => {
            const responseMsg = { id: 999, result: 'unknown' };
            await client.recv(responseMsg);

            expect(tools.log.error).not.toHaveBeenCalled(); // No error logged for unknown response ID
            expect((client as any).requestMap.size).toBe(0); // Map should be empty
        });

        it('should ignore notification for unknown method', async () => {
            const notifyMsg = { method: 'unknownNotify', params: {} };
            await client.recv(notifyMsg);

            expect(tools.log.error).not.toHaveBeenCalled(); // No error logged for unknown notify method
            expect(mockOnSend).not.toHaveBeenCalled();
        });

        it('should send error response for request with unknown method', async () => {
            const requestMsg = { method: 'unknownRequest', id: 125, params: {} };
            await client.recv(requestMsg);

            expect(tools.log.error).not.toHaveBeenCalled(); // No error logged for unknown request method
            expect(mockOnSend).toHaveBeenCalledWith({ id: 125, error: '未找到方法"unknownRequest"' });
        });
    });

    describe('request', () => {
        it('should send a request message and return a promise', async () => {
            const promise = client.request('testMethod', { data: 'value' });

            expect(mockOnSend).toHaveBeenCalledWith({
                method: 'testMethod',
                id: 0, // First request ID
                params: { data: 'value' },
            });
            expect((client as any).requestMap.size).toBe(1);
            expect(typeof promise.then).toBe('function'); // It's a promise

            // Clean up the pending promise to avoid unhandled promise rejection warnings
            (client as any).requestMap.delete(0);
        });

        it('should increment request ID for subsequent requests', () => {
            client.request('method1', {});
            client.request('method2', {});

            expect(mockOnSend).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }));
            expect(mockOnSend).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

            // Clean up
            (client as any).requestMap.delete(0);
            (client as any).requestMap.delete(1);
        });

        it('should return undefined if client is closed', async () => {
            (client as any).closed = true;
            const result = await client.request('closedMethod', {});

            expect(result).toBeUndefined();
            expect(mockOnSend).not.toHaveBeenCalled();
            expect((client as any).requestMap.size).toBe(0);
        });
    });

    it('should send a notify message', () => {
        client.notify('testNotify', { data: 'value' });

        expect(mockOnSend).toHaveBeenCalledWith({
            method: 'testNotify',
            params: { data: 'value' },
        });
    });

    describe('print', () => {
        it('should call terminal.print directly if no buffer', async () => {
            const message = 'Hello, world!';
            await client.print(message);

            expect(mockTerminalInstance.print).toHaveBeenCalledWith(message);
            expect((client as any).printBuffer).toBeUndefined();
        });

        it('should buffer messages if terminal.print is ongoing', async () => {
            // Simulate terminal.print being ongoing by setting printBuffer
            (client as any).printBuffer = [];

            const message1 = 'Message 1';
            const message2 = 'Message 2';

            client.print(message1);
            expect(mockTerminalInstance.print).not.toHaveBeenCalled();
            expect((client as any).printBuffer).toEqual([message1]);

            client.print(message2);
            expect(mockTerminalInstance.print).not.toHaveBeenCalled();
            expect((client as any).printBuffer).toEqual([message1, message2]);

            // Simulate the first print finishing
            await (client as any).applyPrintBuffer();

            // The buffered messages should be printed together
            expect(mockTerminalInstance.print).toHaveBeenCalledWith('Message 1\nMessage 2');
            expect((client as any).printBuffer).toBeUndefined();
        });

        it('should not print empty buffer after flushing', async () => {
            (client as any).printBuffer = [];
            await (client as any).applyPrintBuffer();
            expect(mockTerminalInstance.print).not.toHaveBeenCalled();
        });
    });

    it('should disable input on the terminal', () => {
        client.disableInput();
        expect(mockTerminalInstance.disableInput).toHaveBeenCalled();
    });

    it('should enable input on the terminal', () => {
        client.enableInput();
        expect(mockTerminalInstance.enableInput).toHaveBeenCalled();
    });

    it('should set the client name and recreate the terminal', () => {
        const newName = 'New Client Name';
        const mockCreateTerminal = jest.fn();
        (client as any).createTerminal = mockCreateTerminal; // Mock internal method

        client.setName(newName);

        expect((client as any).name).toBe(newName);
        expect(y3.log.info).toHaveBeenCalledWith('客户端【默认客户端】名称更改为：New Client Name');
        expect(mockCreateTerminal).toHaveBeenCalledWith(newName);
        expect((client as any).didUpdateName.fire).toHaveBeenCalledWith(newName);
    });

    it('should set multiMode on the client and terminal', () => {
        client.setMultiMode(true);
        expect((client as any).multiMode).toBe(true);
        expect(mockTerminalInstance.multiMode).toBe(true);

        client.setMultiMode(false);
        expect((client as any).multiMode).toBe(false);
        expect(mockTerminalInstance.multiMode).toBe(false);
    });

    describe('createTerminal', () => {
        it('should dispose existing terminal and create a new one', () => {
            const oldTerminal = mockTerminalInstance;
            const newTerminal = new (Terminal as any)('New Mock');
            (Terminal as any).mockImplementationOnce(() => newTerminal);

            (client as any).createTerminal('Another Name');

            expect(oldTerminal.dispose).toHaveBeenCalled();
            expect(Terminal).toHaveBeenCalledWith('Another Name');
            expect((client as any).terminalInstance).toBe(newTerminal);
            expect(newTerminal.setApplyHandler).toHaveBeenCalled();
            expect(newTerminal.enableInput).toHaveBeenCalled();
            expect((client as any).applyPrintBuffer).toHaveBeenCalled();
        });

        it('should reuse terminal from history if available', () => {
            const historyTerminal = new (Terminal as any)('History Term');
            (Client as any).terminalHistory['History Name'] = historyTerminal;

            (client as any).createTerminal('History Name');

            expect(mockTerminalInstance.dispose).toHaveBeenCalled(); // Dispose the initial terminal
            expect(Terminal).not.toHaveBeenCalledWith('History Name'); // Should not create a new one
            expect((client as any).terminalInstance).toBe(historyTerminal);
            expect(historyTerminal.setApplyHandler).toHaveBeenCalled();
            expect(historyTerminal.enableInput).toHaveBeenCalled();
            expect((client as any).applyPrintBuffer).toHaveBeenCalled();
            expect((Client as any).terminalHistory['History Name']).toBeUndefined(); // Should remove from history
        });

        it('should set multiMode on the new terminal', () => {
            client.setMultiMode(true); // Set multiMode on client first
            const newTerminal = new (Terminal as any)('Multi Term');
            (Terminal as any).mockImplementationOnce(() => newTerminal);

            (client as any).createTerminal('Multi Name');

            expect(newTerminal.multiMode).toBe(true);
        });
    });

    describe('Static methods', () => {
        beforeEach(() => {
            // Ensure the actual static methods are used for these tests
            jest.unmock('./client');
            // Re-import the actual Client after unmocking
            const actualClientModule = require('./client');
            Client.allClients = []; // Reset actual static state
            Client.button = undefined;
            Client.terminalHistory = {};
            // Re-mock dependencies used by actual static methods
            jest.mock('vscode', () => ({
                ...jest.requireActual('vscode'),
                window: {
                    createStatusBarItem: jest.fn(() => ({
                        show: jest.fn(),
                        dispose: jest.fn(),
                        text: '',
                        tooltip: '',
                        command: '',
                    })),
                },
                StatusBarAlignment: {
                    Left: 1,
                },
                commands: {
                    registerCommand: jest.fn(),
                    executeCommand: jest.fn(),
                },
            }));
            jest.mock('@vscode/l10n', () => ({
                t: jest.fn((s) => s),
            }));
            jest.mock('./terminal'); // Mock Terminal again
            jest.mock('./treeView'); // Mock TreeViewManager again
            jest.mock('../tools', () => ({
                log: {
                    info: jest.fn(),
                    error: jest.fn(),
                },
            }));
            jest.mock('y3-helper', () => ({
                log: {
                    info: jest.fn(),
                    error: jest.fn(),
                },
            }));
        });

        afterEach(() => {
            // Clean up actual static state
            Client.allClients.forEach(c => c.dispose()); // Dispose clients created during tests
            Client.allClients = [];
            Client.button?.dispose();
            Client.button = undefined;
            Client.terminalHistory = {};
            // Re-mock Client for other tests
            jest.mock('./client', () => {
                const actual = jest.requireActual('./client');
                return {
                    ...actual,
                    registerMethod: jest.fn((method, handler) => mockMethods.set(method, handler)),
                    registerRequest: jest.fn((method, handler) => mockRequests.set(method, handler)),
                    Client: class MockClient extends actual.Client {
                        static allClients: MockClient[] = [];
                        static button: any = undefined;
                        static terminalHistory: { [name: string]: Terminal } = {};
                        static updateButton = jest.fn();
                        constructor(onSend: any) {
                            super(onSend);
                            (this as any).treeViewManager = new (TreeViewManager as any)();
                            (this as any).terminal = new (Terminal as any)('Mock Terminal');
                            (this as any).terminal.setApplyHandler = jest.fn();
                            (this as any).terminal.multiMode = false;
                            (this as any).terminal.enableInput = jest.fn();
                            (this as any).terminal.print = jest.fn(async () => {});
                        }
                        get requestMap() { return (this as any).requestMap; }
                        get printBuffer() { return (this as any).printBuffer; }
                        set printBuffer(value: string[] | undefined) { (this as any).printBuffer = value; }
                        get terminalInstance() { return (this as any).terminal; }
                    }
                };
            });
        });

        it('Client.updateButton should create buttons when clients exist', () => {
            const mockCreateStatusBarItem = (vscode.window.createStatusBarItem as jest.Mock);
            const mockButtonInstance = { dispose: jest.fn(), show: jest.fn() };
            mockCreateStatusBarItem.mockReturnValue(mockButtonInstance);

            Client.allClients.push(new Client(jest.fn()));
            Client.updateButton();

            expect(mockCreateStatusBarItem).toHaveBeenCalled();
            expect(Client.button).toBeInstanceOf(mockDisposable); // Buttons extends Disposable
            expect((Client.button as any).buttons.length).toBe(1); // Check if button was added
            expect(mockButtonInstance.show).toHaveBeenCalled();
        });

        it('Client.updateButton should dispose buttons when no clients exist', () => {
            const mockButtonDispose = jest.fn();
            Client.button = { dispose: mockButtonDispose } as any; // Simulate existing button
            (Client.button as any).buttons = [{ dispose: jest.fn() }]; // Simulate button items

            Client.allClients = [];
            Client.updateButton();

            expect(mockButtonDispose).toHaveBeenCalled();
            expect(Client.button).toBeUndefined();
        });

        it('Client.updateButton should do nothing if no clients and no button', () => {
            const mockCreateStatusBarItem = (vscode.window.createStatusBarItem as jest.Mock);
            Client.allClients = [];
            Client.button = undefined;
            Client.updateButton();

            expect(mockCreateStatusBarItem).not.toHaveBeenCalled();
        });

        it('Client.updateButton should do nothing if clients exist and button already exists', () => {
            const mockCreateStatusBarItem = (vscode.window.createStatusBarItem as jest.Mock);
            Client.allClients.push(new Client(jest.fn()));
            Client.button = { dispose: jest.fn() } as any; // Simulate existing button
            (Client.button as any).buttons = [{ dispose: jest.fn() }];

            Client.updateButton();

            expect(mockCreateStatusBarItem).not.toHaveBeenCalled();
        });
    });
});

function expect(arg0: string) {
    throw new Error('Function not implemented.');
}
