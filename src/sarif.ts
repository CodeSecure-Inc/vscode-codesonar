/** SARIF types.
 * 
 *  Defines some types for a subset of the SARIF 2.1 standard.
*/

export interface SarifResult {

}

export interface SarifRun {
    results?: SarifResult[];
}

export interface SarifLog {
    version?: string;
    runs?: SarifRun[];
}

