module.exports = {
    
    nextImportDate: () => {
        const now = new Date();
        return new Date(Date.UTC(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,
            1,
            10,
            0
        ));
    },

    normalizeRouteName: (routeName) => {
        let rawNumber = parseInt(routeName.replace(/\D/g,''));
        let prefix = 'А';

        if (routeName.startsWith('Т') || routeName.startsWith('T')) {
            // tram or trol
            prefix = (rawNumber >= 20) ? 'Тр' : 'Т';
            
        } else if (routeName.startsWith('Н') || routeName.startsWith('H')) {
            // night bus
            prefix = 'Н-А'
        }

        return prefix + ((rawNumber > 10) ? rawNumber : ('0' + rawNumber));
    }    
}