import { IsUUID } from 'class-validator';
import { LocationIdDto } from '../../../common/dto/location-ref.dto';

/** Ported from AddProductToLocationDTO. `stock` is deliberately not accepted: a location starts stocking an item at zero, and stock only moves through a sale or a stock movement, both of which leave a paper trail. */
export class AddProductToLocationDto extends LocationIdDto {
  @IsUUID()
  productItemId: string;
}
