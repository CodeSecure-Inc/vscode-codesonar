/** Front-end for httpClient module. */
// Rely on global nodejs process object since explicitly importing it makes process.exitCode readonly.
//import * as process from 'process';
import { readFile } from 'fs';

import { 
    HTTPClientConnection,
    HTTPClientConnectionOptions,
} from './http_client';


function main(
    argv: string[],
    stdin: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
    onExit: (exitCode:number) => void)
{
    const endl: string = '\n';
    let errorMessage: string|undefined;
    let targetUrlString: string|undefined;
    let cacertFilePath: string|undefined;

    for (let argIndex: number = 1; !errorMessage && argIndex < argv.length; argIndex++)
    {
        let arg: string = argv[argIndex];
        if (arg === '--cacert')
        {
            argIndex += 1;
            if (argIndex < argv.length)
            {
                cacertFilePath = argv[argIndex];
            }
        }
        else if (arg.startsWith('-'))
        {
            errorMessage = `Unrecognized option: '${arg}'.`;
        }
        else if (targetUrlString === undefined)
        {
            targetUrlString = arg;
        }
        else
        {
            errorMessage = `Unexpected argument: '${arg}'.`;
        }
    }

    if (!errorMessage && !targetUrlString)
    {
        errorMessage = "Missing URL argument.";
    }
    if (errorMessage)
    {
        stderr.write(errorMessage + endl);
        onExit(2);
    }
    else if (targetUrlString)
    {
        const targetUrl: URL = new URL(targetUrlString);
        let connOptions: HTTPClientConnectionOptions = {
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: targetUrl.port,
            };
        let doRequest: ((options: HTTPClientConnectionOptions) => void) = (options: HTTPClientConnectionOptions) => {
            let httpConn = new HTTPClientConnection(options);
            stderr.write("start request...\n");
            httpConn.request(targetUrl).then(
                response => {
                    stderr.write("read response...\n");
                    response.body.pipe(stdout);
                });
    
        };
        if (cacertFilePath)
        {
            readFile(
                cacertFilePath,
                (err, data) => {
                    if (err)
                    {
                        stderr.write(err.message + endl);
                        onExit(1);
                    }
                    else if (data)
                    {
                        connOptions.ca = data;
                        doRequest(connOptions);    
                    }
                });
        }
        else
        {
            doRequest(connOptions);
        }
    }
}


if (require.main === module)
{
    main(
        process.argv.slice(1),
        process.stdin,
        process.stdout,
        process.stderr,
        (exitCode) => { process.exitCode = exitCode; });
}
